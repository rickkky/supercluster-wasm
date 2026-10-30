# kdbush vs rbush for Map Point Clustering

An algorithm-level comparison of the two Spatial Index backends considered for this project — a static, build-once kd-tree (the algorithm behind `kdbush`) versus a dynamic R-tree / R*-tree (the algorithm behind `rbush`) — focused on the operations map point clustering actually needs: "find all Points within a bounding box" and "find all neighbors within a radius of a Point".

> Scope note: this document compares the **algorithms and data structures**, not the JavaScript library APIs. All algorithmic claims are grounded in the reference implementation source files listed in [Sources](#sources). Textbook complexity figures are standard theory and are flagged as such; library-author benchmark numbers are attributed to their source.

---

## 1. TL;DR

For map point clustering, **the static kd-tree (kdbush) wins in the common case and is the right default**, because clustering is overwhelmingly a batch-then-query workload: a fixed set of Points is loaded, a Cluster Lattice is built per Zoom Level, and the index is then queried many times (one radius query per Point per zoom) without mutation. The single most important deciding factor is **rebuild amortization**: clustering re-runs the spatial index from scratch at each Zoom Level anyway (or at least at load time), so the kd-tree's weakness — no dynamic updates — never matters, while its strengths (fast bulk build, zero node overlap, tighter radius pruning, ~2× lower memory, single flat ArrayBuffer) all land directly on the hot path. The R-tree only wins when Points are added or removed *after* the index is built and the index cannot be cheaply rebuilt — i.e. genuinely streaming / live mutating scenes — which is the minority case for clustering.

---

## 2. Algorithm Primer

### 2.1 kdbush — static 2D kd-tree

A **kd-tree** ("k-dimensional tree") is a binary space-partitioning tree that alternates the splitting axis: level 0 splits on X, level 1 on Y, level 2 on X, and so on. Each internal node picks a median along the current axis and partitions points into "below median" and "above median" children; leaves are small buckets of points. This yields an implicit balanced binary tree of depth O(log N).

**Static bulk-build (Floyd–Rivest median partitioning).** kdbush does not build a pointer-based tree. It stores all points in two parallel flat typed arrays — `ids` (point indices) and `coords` (interleaved x,y) — and *kd-sorts* them in place so that the median-of-each-subrange lands at the middle index, recursively, alternating axis. The build entry point is `finish()` → `sort()` ([`refs/kdbush/index.js` lines 113–123, 265–277](../../refs/kdbush/index.js)):

```js
function sort(ids, coords, nodeSize, left, right, axis) {
    if (right - left <= nodeSize) return;
    const m = (left + right) >> 1;            // middle index
    select(ids, coords, m, left, right, axis); // partition around m on `axis`
    sort(ids, coords, nodeSize, left, m - 1, 1 - axis);
    sort(ids, coords, nodeSize, m + 1, right, 1 - axis);
}
```

`select()` is a custom Floyd–Rivest selection that places the k-th smallest element at index `k` (on the chosen axis) while reordering `ids` and `coords` in lockstep ([lines 289–327](../../refs/kdbush/index.js)). Recursion stops when a range is ≤ `nodeSize` (default 64) — that bucket is left unsorted and scanned linearly during queries. The result is a flat, implicit, perfectly balanced kd-tree with **no per-node objects, no pointers, and no bounding boxes**. The README calls this "a very fast static spatial index … stored as a single array buffer" ([`refs/kdbush/README.md`](../../refs/kdbush/README.md)).

**Why "build-once / immutable".** `add(x, y)` only works *before* `finish()`; it simply appends into the coordinate array ([lines 102–108](../../refs/kdbush/index.js)). After `finish()`, the array is kd-sorted and the structure is frozen — there is no `insert` or `remove` operation, and `range`/`within` throw if called before `finish()`. Mutating the sorted array would break the median-partition invariant, so any data change requires a full rebuild. The only supported "update" is transferring/sharing the underlying `ArrayBuffer` across threads (`KDBush.from(data)`, `SharedArrayBuffer` support) — a rebuild-avoidance mechanism for *consumers*, not for mutation.

**Bbox range query (`range`).** Iterative depth-first traversal over the implicit tree using a shared scratch stack ([lines 133–181](../../refs/kdbush/index.js)). At each internal node (the median element `m`), it tests the median point directly, then recurses into the left half only if the query's `min` on the current axis is ≤ the median's coordinate, and into the right half only if the query's `max` is ≥ the median. When a range shrinks to ≤ `nodeSize`, it linear-scans the bucket. Crucially, **the two halves of a kd-tree split are disjoint** — a point is either left of the median or right of it, never both — so there is no node overlap and no redundant traversal.

**Radius query (`within` / `withinInto`).** Same iterative DFS, but the pruning predicate is the *axis-aligned bounding box of the query circle*: on axis 0 it recurses left if `qx - r <= x` and right if `qx + r >= x`; axis 1 uses `qy` ([lines 207–254](../../refs/kdbush/index.js)). Candidate points are then accepted by a true squared-distance test `sqDist <= r²` ([lines 358–362](../../refs/kdbush/index.js)). So the radius query is a bbox range query with a cheap pre-filter (the circle's bbox) plus an exact distance post-filter — no separate data structure needed.

### 2.2 rbush — dynamic R-tree (R*-tree split variant)

An **R-tree** is a height-balanced tree of **Minimum Bounding Rectangles (MBRs)**: each leaf entry is a point or rectangle's bbox; each internal node's bbox is the union (MBR) of its children's bboxes. Querying descends into any child whose MBR intersects the query bbox. Unlike a kd-tree, **sibling MBRs may overlap** — a point can fall under multiple children — so the tree is not a strict partition. The R-tree's central tradeoff is that overlap makes search faster to build/maintain but can make queries visit multiple overlapping subtrees.

**Node structure.** Each node is a plain object `{children, height, leaf, minX, minY, maxX, maxY}` where the `min/min/max/max` fields are the node's own MBR ([`refs/rbush/index.js` lines 483–493](../../refs/rbush/index.js)). `maxEntries` (default 9; 40% → `minEntries`) bounds fan-out. Leaves hold data items; internal nodes hold child nodes.

**Insert — `chooseSubtree` + split.** To insert one item, rbush walks from root to leaf choosing, at each level, the child whose MBR would enlarge *least* to absorb the item, tie-broken by smallest area ([`_chooseSubtree`, lines 233–267](../../refs/rbush/index.js)). If the chosen node overflows (`children.length > maxEntries`), it splits and the split propagates up to the root, growing the tree height by one when the root itself splits ([`_insert` / `_split` / `_splitRoot`, lines 269–319](../../refs/rbush/index.js)).

**Split — the R*-tree part.** rbush uses the R*-tree's *split heuristics* but not the rest of the R*-tree. Specifically:
- **Split-axis choice** (`_chooseSplitAxis`, [lines 353–362](../../refs/rbush/index.js)): compute the total margin (perimeter) of all valid split distributions along X and along Y (`_allDistMargin`), then sort children along the axis with the smaller total margin. This is the R*-tree "choose split axis" heuristic.
- **Split-index choice** (`_chooseSplitIndex`, [lines 321–350](../../refs/rbush/index.js)): among all distributions with at least `minEntries` per side, pick the one with **minimum overlap** between the two resulting MBRs, tie-broken by minimum total area. This is the R*-tree "choose split index" heuristic.

The README is explicit that rbush does **not** adopt the other two R*-tree ideas — forced reinsertion on overflow and overlap-minimizing subtree selection — because "in JS [they are] too slow and not worth it" ([`refs/rbush/README.md` "Algorithms Used"](../../refs/rbush/README.md)). So rbush is best described as an **R-tree with R*-tree-quality splits** (and a non-recursive insertion path), not a full R*-tree.

**Remove — free-at-empty condense.** Deletion does a depth-first search for the item, splices it out, then condenses the path upward. Notably, underflowed nodes (those below `minEntries`) are **not reinserted**; instead they are kept in the tree and deleted only when they become completely empty ([`_condense`, lines 395–407](../../refs/rbush/index.js); README "single deletion"). This is a deliberate query-favor-over-removal-favor tradeoff: removal stays cheap and the tree doesn't degrade into a flurry of reinsertions, at the cost of leaving slightly underfull nodes that may slightly hurt query fan-out.

**Search.** Standard non-recursive R-tree search ([lines 15–39](../../refs/rbush/index.js)): starting at the root, for each child whose MBR intersects the query bbox, either push the result (leaf), dump all of a fully-contained child's subtree (`contains` → `_all`), or enqueue the child for further traversal. Because MBRs can overlap, a query may have to visit several sibling subtrees covering the same region.

**Bulk loading — OMT (Overlap Minimizing Top-down).** `load()` into an empty tree builds from scratch with the OMT algorithm ([`_build`, lines 181–231](../../refs/rbush/index.js)): it computes a target height, then recursively slices the data into roughly square tiles by sorting on X with `multiSelect`+`quickselect`, then on Y within each X-slice, packing each tile as a child node. `multiSelect` ([lines 498–512](../../refs/rbush/index.js)) is a binary-divide-and-conquer wrapper around `quickselect` that produces groups of n unsorted items with groups sorted between them. Bulk insertion into a *non-empty* tree uses the STLT (Small-Tree-Large-Tree) approach: build a small tree from the new data and insert it as a subtree at the appropriate level ([`load`, lines 63–97](../../refs/rbush/index.js)).

**kNN / radius — rbush-knn.** rbush itself only has bbox `search`. Radius/kNN is provided by the companion `rbush-knn` module ([`refs/rbush-knn/index.js`](../../refs/rbush-knn/index.js)): a best-first search using a min-heap keyed by `boxDist` — the squared axis-aligned distance from the query point to a node's MBR ([lines 41–49](../../refs/rbush-knn/index.js)). It pops the nearest node, expands its children, and collects leaf items in increasing distance order. A radius query is expressed as `knn(tree, x, y, Infinity, predicate, R)` — k = Infinity with `maxDistance = R` — which prunes any node whose MBR's `boxDist` exceeds R². Note the asymmetry vs kdbush: rbush-knn prunes by **distance to the node MBR** (an over-approximation that includes the whole bounding box), whereas kdbush `within` prunes by the **axis-aligned bounding box of the query circle against the median split** — different over-approximations, discussed in §5.

---

## 3. Complexity Comparison

N = number of Points; k = number of results reported by a query; M = node fan-out (`maxEntries` for rbush, `nodeSize` for kdbush). Assumptions: 2D, balanced tree, uniformly distributed data. "Standard theory" = textbook result, not measured in this repo; "measured" = author-reported number from a benchmark file.

| Operation | kdbush (static kd-tree) | rbush (R-tree, R*-tree splits) | Notes / source |
|---|---|---|---|
| **Build (bulk load), N points** | O(N) expected, O(N log N) worst — single Floyd–Rivest kd-sort over flat arrays. Measured: indexes 1M points in one `console.time` run ([`bench.js`](../../refs/kdbush/bench.js)). | O(N log N) — OMT top-down bulk load via `multiSelect`+`quickselect`. Measured: bulk-insert 1M items in 1.25s; one-by-one insert 1M in 3.18s ([`refs/rbush/README.md` Performance](../../refs/rbush/README.md)). | rbush README states kdbush indexes points "5–8x faster than RBush". |
| **Single bbox range query** | O(√N + k) standard theory for a balanced 2D kd-tree orthogonal range search; in practice the iterative DFS visits O(log N) internal nodes + O(√N + k) leaves. No node overlap. | O(log N + k) best case, but **overlap-dependent**: a query may visit every overlapping subtree, degrading toward O(N) in the worst case. Measured: 1000 × 0.01%-area searches in 0.03s; 1000 × 1% in 0.35s; 1000 × 10% in 2.18s ([README Performance](../../refs/rbush/README.md)). | rbush `search` is O(N) worst-case (all MBRs overlap the query); kdbush `range` is overlap-free. |
| **Single radius query** | O(√N + k) standard theory — `within` reuses the same DFS with the circle's bbox as the pruning predicate, then an exact `sqDist` post-filter ([`index.js` lines 207–254](../../refs/kdbush/index.js)). | No native radius op; done via `rbush-knn` best-first search with `maxDistance = R`, pruning by MBR distance. O(log N + k) best case, overlap-dependent. | kdbush prunes by the query circle's bbox vs the median split; rbush-knn prunes by point-to-MBR distance. Different over-approximations (see §5). |
| **Insert one point** | **Not supported** after `finish()`. A single insertion requires a full rebuild. | O(log N) typical — `chooseSubtree` walk + possible split propagation. Measured: 1M one-by-one inserts in 3.18s ⇒ ~3µs/insert. | The defining asymmetry. |
| **Remove one point** | **Not supported**. Full rebuild. | O(log N) typical for the search; condense is free-at-empty so removal is cheap. Measured: remove 1000 items in 0.02s ⇒ ~20µs/remove ([README Performance](../../refs/rbush/README.md)). | rbush removal does *not* reinsert underflowed entries, so it stays fast but can leave underfull nodes. |
| **Memory / overhead** | ~2 coords + 1 id per point, flat. `Float64Array` default ⇒ 24 B/point + 8B header; `Int32Array` ⇒ 12 B/point. Single contiguous `ArrayBuffer`. README: "~2× less memory than Flatbush" for points. | Per-node object overhead: each node carries `{children, height, leaf, minX, minY, maxX, maxY}` plus a JS array of children; every point item is a separate object with its own bbox fields. Substantially higher per-point overhead and GC pressure. | kdbush is the clear winner under a tight memory budget (browser/wasm heap). |
| **Thread transfer / serialization** | Trivial — `postMessage(index.data, [index.data])`; `KDBush.from(buffer)`. O(1) transfer (zero-copy). | `toJSON()`/`fromJSON()` walks the whole tree; no zero-copy transfer. | Matters for worker/main-thread handoff of a prebuilt index. |

---

## 4. Scenario-by-Scenario Comparison for Map Point Clustering

### 4.1 Static dataset, clustered once at load (e.g. 1M Points loaded once)
**Winner: kdbush.** This is its design center. Build is a single O(N) kd-sort; the resulting flat ArrayBuffer is compact and transferable; range/radius queries have no node overlap. rbush can also bulk-load (OMT) and would be functional, but it pays for a dynamic-capability data structure (per-node objects, MBRs, split machinery) that this scenario never exercises. The rbush README itself says "if you're indexing a static list of points … use kdbush which performs point indexing 5–8x faster than RBush" ([README, "Data Format"](../../refs/rbush/README.md)).

### 4.2 Frequently mutating dataset (Points added/removed as the user moves, live/streaming data)
**Winner: rbush.** This is the one scenario where kdbush cannot compete: every single Point addition or removal requires a full O(N) rebuild, which is untenable as N grows. rbush handles per-point `insert`/`remove` in O(log N) without touching the rest of the tree. The `CONTEXT.md` framing — "kdbush (static, build-once) for batch scenes; rbush (dynamic, insert/remove) for mutable scenes" ([`CONTEXT.md`](../../CONTEXT.md)) — captures exactly this split. **Caveat (see §5.1):** if the mutation rate is low or batched, rebuilding a kdbush per batch may still beat maintaining an rbush, because kdbush's build is so cheap and its queries are overlap-free.

### 4.3 Per-zoom rebuild of the Cluster Lattice (clustering re-runs at each Zoom Level)
**Winner: kdbush, usually.** Clustering typically builds a fresh Cluster Lattice per Zoom Level: at each zoom it runs a radius query around every Point (or every not-yet-clustered Point) to form Clusters. Two sub-cases:
- **Index rebuilt per zoom** (e.g. a fresh spatial index per zoom's point set): kdbush's O(N) bulk build is the cheapest possible build, and it amortizes across the ~N radius queries that zoom will issue. rbush's OMT build is also bulk but slower and heavier.
- **Index reused across zooms** (same Point set, different radii): even better for kdbush — one build, many queries, zero mutation needed. rbush gains nothing here because no mutation occurs.

The only way rbush wins in this scenario is if the per-zoom point set *changes by a few Points between zooms* and you want to avoid a rebuild — but clustering's zoom stepping is typically a re-clustering of the same underlying Points at a different radius, not an incremental edit, so the rebuild-avoidance case is rare.

### 4.4 Pan/zoom-driven repeated bbox queries over the same data (many queries, same index)
**Winner: kdbush.** This is the "viewport query" workload: as the user pans/zooms, the map issues many bbox `search`/`range` calls against the same index. Here the build cost is fully amortized and what matters is per-query latency and overlap. kdbush `range` has no node overlap and prunes cleanly by axis; rbush `search` may visit multiple overlapping MBRs per query. For small viewports (typical pan), kdbush's O(√N + k) is tight; rbush's overlap-dependent fan-out can only match or exceed it. rbush is competitive but not superior.

### 4.5 Radius / "neighbors within R" queries (the core clustering primitive)
**Winner: kdbush, for small R (the clustering case).** Clustering's inner loop is "for each Point, find all Points within radius R" — exactly kdbush `within`. The asymmetry:
- **kdbush `within`** prunes by the *query circle's axis-aligned bbox* against each median split: recurse left only if `qx - r <= median.x`, right only if `qx + r >= median.x`. For small R the circle's bbox is small, so most branches are pruned early; the exact `sqDist` test then filters the few candidates. The pruning boundary is the median line — a tight, exact split.
- **rbush-knn with maxDistance=R** prunes by *point-to-MBR squared distance*: a node is visited if its MBR's nearest point to the query is within R. Because MBRs overlap and are axis-aligned rectangles that can be much larger than the points they contain, this over-approximation is looser for small R — a node whose MBR is within R may contain zero actual points within R, yet still gets expanded. rbush-knn also pays heap (priority-queue) overhead per visited node, which kdbush's flat stack-based DFS avoids.

For **large R** (cover most of the map), both degrade toward O(N) and the difference shrinks; rbush's MBR-based pruning can even be competitive because large circles intersect most MBRs anyway. But clustering uses small R (a cluster's neighborhood radius in world units is small, especially at high Zoom Levels), which is exactly the regime where kdbush's tighter pruning wins.

### 4.6 Small N (hundreds–thousands) vs large N (millions)
- **Small N:** both are fine; the index overhead may dominate the actual query work. kdbush's flat arrays still win on memory and build simplicity; rbush's per-node object overhead is relatively more painful at small N. Either works.
- **Large N (millions):** **kdbush wins decisively.** (a) Memory: kdbush's 12–24 B/point flat buffer vs rbush's per-node/per-item objects keeps the wasm heap or browser memory budget viable. (b) Build: kdbush's O(N) kd-sort scales linearly; rbush's OMT bulk load is O(N log N) with higher constant factors. (c) Query: kdbush's overlap-free O(√N + k) stays predictable; rbush's overlap fan-out grows with N. (d) Transfer: a multi-megabyte kdbush `ArrayBuffer` transfers between worker and main thread zero-copy; rbush has no equivalent.

### 4.7 Tight memory budget (in-browser / wasm heap)
**Winner: kdbush.** This is not close. kdbush stores exactly `2·sizeof(coord) + sizeof(id)` bytes per Point in one contiguous `ArrayBuffer` (12 B/point with `Int32Array`, 24 B/point with `Float64Array`) plus an 8-byte header — no per-node objects, no MBRs, no GC pressure, and the buffer is directly usable from wasm linear memory. rbush stores a JS object per node (with 4 MBR numbers + a children array) and a separate object per data item; for millions of Points this is both larger and far more GC-hostile. The kdbush README explicitly highlights "~2× less memory than Flatbush" for points ([README](../../refs/kdbush/README.md)), and Flatbush itself is already leaner than rbush.

---

## 5. Clustering-Specific Gotchas

### 5.1 "R-trees support dynamic updates, but clustering rebuilds anyway — does that erase rbush's advantage?"
**Largely yes, for the batch case.** rbush's defining strength — O(log N) insert/remove — only pays off when mutations happen *against a long-lived index that is too expensive to rebuild*. Clustering's typical lifecycle is: load N Points → build Cluster Lattice (which needs a spatial index) → serve many viewport/radius queries → (maybe) step to the next Zoom Level and re-cluster. If the Point set is stable across that sequence, the index is effectively rebuilt per zoom or per load, and kdbush's cheap O(N) build + overlap-free queries win. rbush's dynamic capability is pure overhead here.

The dynamic advantage only materializes when (a) Points arrive/depart *after* the lattice is built and (b) the rebuild cost exceeds the incremental-update cost. For low N or low mutation rates, even a per-batch kdbush rebuild can beat maintaining an rbush, because kdbush's build is so cheap (the README's "5–8x faster" build claim is exactly this). The crossover — "how many mutations before rbush's incremental beats kdbush's rebuild" — is scenario-dependent and should be measured, but the threshold is higher than intuition suggests because kdbush builds are nearly free.

### 5.2 R-tree query performance depends on node overlap / fill; R*-tree mitigates but doesn't eliminate
rbush uses the R*-tree's *split heuristics* (margin-minimizing axis choice, overlap-minimizing split index — [`_chooseSplitAxis`/`_chooseSplitIndex`](../../refs/rbush/index.js)) which produce tighter, less-overlapping nodes than a plain R-tree. But it deliberately drops R*-tree forced reinsertion and overlap-minimizing subtree selection (README: "too slow and not worth it"), so it gets R*-tree-quality *splits* without the full R*-tree query quality. Sibling MBRs can still overlap, and `search` may visit multiple overlapping subtrees for one query. kdbush's median splits are a strict partition — **zero overlap by construction** — so its range queries never revisit a region through multiple branches. For clustering's many small-bbox/small-radius queries, this overlap-free property is a consistent, predictable win.

### 5.3 Radius query pruning: kd-tree axis-distance vs R-tree MBR-distance
For small radii (the clustering regime), kdbush's pruning is tighter. `within` prunes each internal node by testing the query circle's bbox against the median line: "is any of this circle within `qx ± r` (or `qy ± r`) of the median?" — a tight, exact test against a zero-width split boundary. rbush-knn prunes by `boxDist` = squared distance from the query point to the child's MBR — an over-approximation that treats the whole bounding rectangle as the geometry. When MBRs are tight around their points (well-packed bulk-loaded tree, small R), the over-approximation is small; when MBRs are loose (after many incremental inserts/removes, or scattered data), the over-approximation grows and rbush-knn expands nodes that contain no in-radius points. Clustering's small R amplifies this difference: the smaller R is, the more kdbush's exact median pruning pays off relative to rbush's MBR-distance pruning.

### 5.4 Rebuild cost amortization
The decision hinges on **queries-per-build**:
- If the index is rebuilt per zoom (or per load) and then queried ~N times (one radius per Point) plus ~V viewport queries, the build cost amortizes across O(N + V) queries. kdbush's O(N) build divided by O(N) queries is O(1) amortized — essentially free — and its per-query cost is lower. kdbush wins.
- If the index is built once and reused across *many* zooms *and* many viewport queries with no mutation, both amortize the build away, and kdbush still wins on per-query overlap-freedom and memory.
- If the index must absorb mid-lifetime mutations, rbush's incremental O(log N) updates beat kdbush's O(N) rebuild — but only if rebuilding is actually too expensive to do per batch (see §5.1).

---

## 6. Recommendation Matrix

| If your scenario is… | Choose… | Because… |
|---|---|---|
| Fixed Points loaded once, cluster at load | **kdbush** | O(N) build, zero overlap, minimal memory; rbush's dynamic machinery is unused overhead. |
| Points stream in/out live, index must stay queryable mid-mutation | **rbush** | O(log N) insert/remove vs kdbush's O(N) rebuild; the only case where dynamism pays. |
| Per-zoom rebuild of the Cluster Lattice | **kdbush** | Build is O(N) and amortizes across the zoom's ~N radius queries; no mutation needed. |
| Many pan/zoom bbox queries, same index | **kdbush** | Overlap-free range queries; predictable O(√N + k) per viewport. |
| Radius queries with small R (core clustering primitive) | **kdbush** | `within` prunes by exact median split + circle bbox; tighter than rbush-knn's MBR-distance pruning for small R. |
| Small N (hundreds–thousands) | either | Both fine; kdbush still simpler/lower-overhead. |
| Large N (millions) | **kdbush** | ~12–24 B/point flat buffer, O(N) build, zero-copy worker transfer; rbush's per-object overhead doesn't scale. |
| Tight memory budget (wasm heap / mobile browser) | **kdbush** | Single contiguous ArrayBuffer, no per-node objects, no GC pressure. |
| Need to index rectangles, not just points | **rbush** (or Flatbush) | kdbush is points-only; rbush handles rectangles natively. |
| Low/medium mutation rate, batched updates | **kdbush** (rebuild per batch) | kdbush build is cheap enough that per-batch rebuild often beats maintaining an rbush — measure the crossover. |

---

## 7. Sources

Primary (in-repo reference implementations and their docs):

- [`refs/kdbush/README.md`](../../refs/kdbush/README.md) — kdbush algorithm description: static 2D kd-tree, points-only, immutable after `finish()`, single ArrayBuffer storage, "~2× less memory than Flatbush" for points.
- [`refs/kdbush/index.js`](../../refs/kdbush/index.js) — kdbush implementation: `sort`/`select` Floyd–Rivest bulk-build (lines 113–123, 265–327), `range` iterative DFS with axis pruning (133–181), `within`/`withinInto` radius search with circle-bbox pruning + `sqDist` post-filter (207–254, 358–362), flat ArrayBuffer layout (54–93).
- [`refs/kdbush/bench.js`](../../refs/kdbush/bench.js) — kdbush author's benchmark harness: indexes 1M points, 10000 small bbox + 10000 small radius queries (no fixed timing numbers committed; structure confirms the workload shape).
- [`refs/rbush/README.md`](../../refs/rbush/README.md) — rbush algorithm description: R-tree with R*-tree split routine only (forced reinsertion and overlap-minimizing subtree search dropped as "too slow"), OMT bulk loading, STLT bulk insertion, free-at-empty deletion; Performance table (insert 1M in 3.18s, 1000 × 0.01% searches in 0.03s, remove 1000 in 0.02s, bulk-insert 1M in 1.25s); "kdbush performs point indexing 5–8x faster than RBush".
- [`refs/rbush/index.js`](../../refs/rbush/index.js) — rbush implementation: node/MBR structure (483–493), `search` with overlap-dependent traversal (15–39), `chooseSubtree` least-enlargement (233–267), R*-tree `_chooseSplitAxis`/`_chooseSplitIndex` (321–362), free-at-empty `_condense` (395–407), OMT `_build` + `multiSelect` (181–231, 498–512), STLT `load` (63–97).
- [`refs/rbush/bench/perf.js`](../../refs/rbush/bench/perf.js) and [`refs/rbush/bench/*.bench.js`](../../refs/rbush/bench/) — rbush author's benchmark harnesses (1M insert/search/remove, 10k bulk-load/search); confirm the workload shapes behind the README Performance table.
- [`refs/rbush-knn/README.md`](../../refs/rbush-knn/README.md) and [`refs/rbush-knn/index.js`](../../refs/rbush-knn/index.js) — rbush kNN/radius via min-heap best-first search keyed by `boxDist` (point-to-MBR squared distance); radius query = `knn(..., Infinity, predicate, R)`; documents the MBR-distance pruning asymmetry vs kdbush's median pruning.

Secondary (in-repo context):

- [`CONTEXT.md`](../../CONTEXT.md) — project glossary and scenario framing: "Point", "Cluster", "Zoom Level", "Cluster Lattice", "Spatial Index"; states the batch-vs-mutable design split (kdbush for batch scenes, rbush for mutable scenes) that this report's scenario analysis is organized around.

External (textbook/authoritative) — consulted for standard complexity theory but not directly fetched during this research (web tools were unavailable in the session; the complexity figures are standard, well-established results and are flagged as "standard theory" in §3 rather than attributed to a benchmark):

- Bentley, J. L. (1975), "Multidimensional Binary Search Trees Used for Associative Searching" — the original kd-tree paper; source of the O(√N + k) 2D orthogonal range-query bound for balanced kd-trees.
- Guttman, A. (1984), "R-Trees: A Dynamic Index Structure for Spatial Searching" — the original R-tree paper (linked from the rbush README); source of the R-tree search/insert/remove complexity and the overlap-dependence of query performance.
- Beckmann, Kriegel, Schneider, Seeger (1990), "The R*-tree: An Efficient and Robust Access Method for Points and Rectangles" — the R*-tree paper (linked from the rbush README); source of the split-axis/split-index heuristics and forced-reinsertion description.
- de Berg, Cheong, van Kreveld, Overveld, *Computational Geometry: Algorithms and Applications* — standard textbook reference for kd-tree and orthogonal range-search complexity.

---

*Could not verify from primary sources within this session:* the precise textbook complexity bounds (O(√N + k) kd-tree range query, O(log N + k) R-tree best-case search) are standard theory rather than numbers measured in the repo's benchmark files — the in-repo benchmarks report wall-clock times, not asymptotic bounds, and the external textbook/paper sources could not be fetched because web tools were unavailable. The bounds are well-established and are flagged as "standard theory" in §3.
