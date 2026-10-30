# Supercluster-WASM Spec

Status: ready-for-agent

## Problem Statement

Frontend map applications clustering large point datasets (millions of points) with the JavaScript `supercluster` library hit performance walls: the `load()` build (which re-runs a per-zoom radius-query clustering pass over every point) dominates load time at scale, and pan/zoom viewport queries add latency on the interaction hot path. There is no browser-native path to materially faster clustering without leaving JavaScript's runtime. The user needs clustering that stays correct (same clusters as supercluster would produce) while running fast enough on the browser's main thread / worker pool to keep large maps interactive.

## Solution

A WASM-compiled Rust library, `supercluster-wasm`, that performs geospatial point clustering in the browser and outperforms the JavaScript `supercluster` on both the build and query hot paths. The clustering index lives in WASM linear memory, opaque to JS; build and all queries run as WASM calls inside a Web Worker, with only compact result data crossing the boundary. Correctness is defined as **semantic equivalence** to JS supercluster — identical cluster membership per zoom level — not byte-identical output, using supercluster's fixtures and generated datasets as the oracle. The public API is custom (not a 1:1 port) but covers the same surface minus `getTile`, and is drop-in compatible with mapbox-gl/deck.gl-style `getClusters` consumers.

## User Stories

1. As a map application developer, I want to cluster millions of points in the browser without blocking the main thread, so that the map stays interactive during load.
2. As a map application developer, I want viewport cluster queries (pan/zoom) to return in single-digit milliseconds at 1M+ points, so that panning feels instant.
3. As a map application developer, I want a drop-in replacement for JS supercluster's `getClusters(bbox, zoom)` API, so that I can adopt the library without rewriting my rendering layer.
4. As a map application developer, I want to drill into a cluster via `getChildren(clusterId)`, so that users can expand clusters on click.
5. As a map application developer, I want to paginate a cluster's leaves via `getLeaves(clusterId, limit, offset)`, so that I can render large clusters incrementally.
6. As a map application developer, I want `getClusterExpansionZoom(clusterId)`, so that I know at which zoom a cluster breaks apart.
7. As a map application developer, I want the library to expose a declarative aggregation spec (sum/count/min/max/mean over named point properties), so that clusters carry aggregated properties without me writing JS reduce callbacks that would kill WASM performance.
8. As a map application developer, I want clusters that fall back to `point_count` only when I need no custom aggregation, so that the common case needs no spec.
9. As a map application developer, I want the library to handle edge inputs gracefully — empty point sets, out-of-range bboxes, non-integer zooms, duplicate coordinates — so that user interaction never crashes the map.
10. As a map application developer, I want antimeridian-crossing bbox queries to return the correct wrapped results, so that maps near the international date line behave correctly.
11. As a map application developer, I want the WASM module to load and initialize in a Web Worker, so that the main thread is never blocked by clustering compute.
12. As a map application developer, I want query results returned as compact typed arrays, so that the WASM→JS boundary crossing stays cheap even for large result sets.
13. As a library maintainer, I want a benchmark harness that runs the same datasets through JS supercluster and the WASM version and reports build/query timing ratios, so that performance claims are falsifiable and reproducible.
14. As a library maintainer, I want the harness to use both uniform-random and clustered-realistic datasets, so that performance is validated on real map shapes, not just synthetic uniform data.
15. As a library maintainer, I want a semantic-equivalence oracle that diffs cluster membership per zoom against JS supercluster, so that "correct" is defined before any optimization.
16. As a library maintainer, I want the kdbush spatial index ported with isolated unit tests, so that index bugs are separable from clustering-logic bugs.
17. As a library maintainer, I want the clustering logic to use the same f32 spherical-mercator projection as supercluster, so that boundary-point membership is directly comparable to the oracle.
18. As a library maintainer, I want the option semantics (radius/extent/minPoints/maxZoom/nodeSize defaults and formulas) to match supercluster, so that the equivalence oracle holds without parameter drift.
19. As a library maintainer, I want the kdbush port to be hand-written with zero external index dependencies, so that the hot path is fully controllable and the wasm bundle stays small.
20. As a library maintainer, I want build and query timings reported separately, so that optimization effort targets the actual bottleneck.
21. As a map application developer, I want TypeScript type definitions shipped with the library, so that I get type safety in my rendering layer.
22. As a map application developer, I want the library to preserve supercluster's option defaults (radius 40, extent 512, minPoints 2, maxZoom 16, nodeSize 64), so that out-of-the-box behavior matches what map developers already tune for.

## Implementation Decisions

- **Custom API, not a 1:1 port.** The public surface is custom; correctness is semantic equivalence (cluster membership per zoom) to JS supercluster, not byte-identical output. See ADR 0001.
- **API surface.** Methods: `load(points)`, `getClusters(bbox, zoom)`, `getChildren(clusterId)`, `getLeaves(clusterId, limit, offset)`, `getClusterExpansionZoom(clusterId)`. `getTile` is intentionally excluded (geojson-vt tile-coordinate output model and its separate antimeridian tile-wrapping are out of scope). See Q6.
- **Index stays in WASM, opaque to JS.** The per-zoom kd-tree and the per-point stride data live in WASM linear memory; they are not exposed or transferred to JS. Build and all queries run as WASM calls inside a Web Worker; only compact result data crosses the boundary. The kdbush serialized ArrayBuffer format is not reproduced. See ADR 0002, Q4.
- **Worker model.** Single Web Worker; build and queries run there, exposed to JS as async methods. Worker pooling is deferred (data-driven: only if the single-worker baseline is unacceptable at target N). The per-zoom clustering loop is layer-dependent (zoom Z's input is zoom Z+1's output), so inter-layer parallelism is not available. See Q11.
- **kdbush implementation.** Hand-ported Floyd–Rivest kd-tree (bulk build via in-place kd-sort, iterative DFS `range`/`within` with circle-bbox pruning + squared-distance post-filter), zero external spatial-index dependencies. Mirrors `refs/kdbush/index.js` algorithmically so the equivalence oracle is straightforward. See Q8.
- **Projection precision.** f32 spherical-mercator `[0..1]` projection, matching supercluster's `fround`; stored coordinates and pruning use f32; intermediate accumulations (squared radius, weighted-center sums) may use f64 to avoid error growth. Chosen so cluster membership is directly comparable to supercluster for the oracle. See ADR 0003, Q9.
- **Option semantics.** Defaults and formulas match supercluster: `radius=40`, `extent=512`, `minPoints=2`, `maxZoom=16`, `nodeSize=64`; radius-per-zoom formula `r = radius / (extent * 2^zoom)`. `minPoints` governs minimum cluster size; `maxZoom` is the highest clustering zoom. Preserved verbatim because the equivalence oracle requires identical pruning boundaries. See Q15.
- **Aggregation.** No JS `reduce`/`map` callbacks (they would force per-point JS↔WASM boundary chatter during build, killing performance). Instead a declarative aggregation spec over named point properties covering sum/count/min/max/mean. Clusters without a spec carry `point_count` (and abbreviated form) only. Custom needs not covered by the spec fall back to `getLeaves` + JS-side aggregation. See Q7.
- **Result serialization.** Query results cross the WASM→JS boundary as compact typed arrays (flat id + coordinate + count + cluster/point tag), written into a freshly allocated buffer per query; JS reads via a zero-copy `Float32Array` view and assembles GeoJSON on the JS side. No scratch-buffer reuse across queries (avoids `Float32Array::view` aliasing UB given variable result sizes). See Q10, Q18.
- **Internal data layout.** Structure-of-Arrays (SoA): x, y, lastZoom, sourceId, parentId, numPoints (and aggregation accumulators) stored in separate typed arrays, not supercluster's stride AoS. Chosen for cache efficiency on the radius-query hot path (which reads only x/y). See Q19.
- **WASM binding.** `wasm-bindgen` + `wasm-pack` (target web/bundler). Result typed arrays shared via `js_sys::Float32Array::view` borrowing WASM linear memory. See Q14.
- **Error handling and boundary behavior.** Matches supercluster: `load([])` returns empty without throwing; out-of-range bbox values are clamped/wrapped, not rejected; non-integer zooms floor to integer; duplicate coordinates cluster normally; antimeridian-crossing `getClusters` bboxes split into eastern/western hemisphere queries and concatenate. See Q16.
- **Benchmark harness.** Replicates `refs/supercluster/bench.js`'s 1M uniform-random configuration (lng -180..180, lat -80..80, maxZoom 6), extends to 6M for boundary, and adds a clustered-realistic dataset (synthetic: Natural Earth populated-places city coordinates as sampling centers, Gaussian-sampled points per city, population-weighted). Measures `load` total time, small/large bbox `getClusters` batches, and `getChildren`/`getLeaves` drill-down batches; reports geometric mean + JS/WASM ratio. The harness is the first deliverable — it establishes the JS baseline before any Rust optimization. See Q12, Q13, Q17.
- **Delivery order.** (1) Benchmark harness with JS supercluster baseline + dual dataset generator + semantic-equivalence oracle seeded from `places.json`; (2) hand-ported kdbush with isolated unit tests (range/within vs brute force); (3) supercluster clustering logic port; (4) wasm-bindgen + Web Worker boundary wiring; (5) run harness comparison, optimize from data. See Q20.
- **cluster_id encoding.** Internal cluster ids need only be stable and drillable (support `getChildren`/`getLeaves`/`getClusterExpansionZoom`); they are not required to match supercluster's `(i<<5)+zoom+len` encoding, since the oracle compares membership, not id values.
- **Licensing.** Reference implementations (supercluster, kdbush) are ISC-licensed (© Mapbox / © Agafonkin); attribution retained. The `places.json` fixture (163 real geographic points, ISC) is brought in as the oracle corpus with attribution; generated datasets are synthetic.

## Testing Decisions

- **Test external behavior, not implementation details.** No tests assert SoA layout, Floyd–Rivest sort internals, or f32 accumulation mechanics — those are implementation choices covered indirectly by behavior tests.
- **Primary seam — public API via semantic-equivalence oracle.** The single highest seam: feed identical inputs to JS supercluster and the Rust version, assert cluster membership per zoom is identical. Black-box. Covers the whole stack (kdbush, clustering, projection, options, antimeridian) in one assertion family. Seed corpus: `refs/supercluster/test/test.js`'s 15 cases against `places.json` fixtures, extended to generated 1M/6M sets. Prior art: `refs/supercluster/test/test.js`.
- **Sub-seam A — kdbush `range`/`within` isolated unit tests.** One layer below the primary seam. Asserts range/within results match brute-force scans over the same points (workload shape from `refs/kdbush/bench.js`: 1M points, 10k small bbox + 10k small radius queries). De-risks the primary seam by isolating index bugs from clustering-logic bugs. Prior art: `refs/kdbush/bench.js`.
- **Sub-seam B — WASM↔JS boundary typed-array contract.** Tests that the compact result array the WASM call returns decodes to the expected id+coord+count+tag set for a given query. Tests the encoding at the point where encoding matters; not a new cross-codebase seam.
- **Oracle scope.** The oracle asserts cluster membership per zoom as the core equivalence. `getChildren`/`getLeaves`/`getClusterExpansionZoom` are tested for behavioral correctness (correct children, correct paginated leaves, correct expansion zoom including the beyond-maxZoom case) against supercluster's expected outputs from `test.js`, not folded into the membership oracle.
- **Edge cases.** Empty input, out-of-range bbox, non-integer zoom, duplicate coordinates, antimeridian crossing, null-property features — all covered by porting `test.js`'s corresponding cases as the oracle corpus.
- **Performance tests are not correctness tests.** The benchmark harness reports timing ratios but does not gate correctness; it lives alongside the test suite as a separate deliverable.

## Out of Scope

- **`getTile` / geojson-vt-compatible tile output.** Excluded (Q6). Tile-coordinate geometry and tile-level antimeridian wrapping are a separate output model not needed by `getClusters`-style consumers.
- **Dynamic point mutation after `load`.** No `insert`/`remove`; the index is build-once (matches kdbush's static model and the research doc's conclusion that clustering is a batch-then-query workload). A mutation-capable variant (rbush-style) is a different library.
- **Worker pooling / multi-worker parallel build.** Deferred; single-worker baseline first, pooling only if data shows it's needed (Q11).
- **JS `reduce`/`map` callbacks.** Removed in favor of declarative aggregation (Q7). Arbitrary JS-side aggregation is available via `getLeaves` + JS, not via build-time callbacks.
- **Exposing or transferring the index buffer to JS.** The index is opaque to JS (ADR 0002); the kdbush serialized format is not reproduced.
- **1:1 output compatibility with mapbox-gl/deck.gl supercluster sources.** The API is custom; drop-in is at the `getClusters`-shape level, not byte-level (ADR 0001).
- **Rectangles / non-point geometries.** Points only (kdbush is points-only; rectangles would need rbush).
- **CI pipeline, npm publishing, versioning.** Not specified here; implementation-time concerns.

## Further Notes

- **Domain glossary** is in `CONTEXT.md` (Point, Cluster, Zoom Level, Cluster Lattice, Cluster Hierarchy, Spatial Index). The spec uses that vocabulary.
- **ADRs** in `docs/adr/`: 0001 (custom API, not 1:1 port), 0002 (index stays in WASM, opaque), 0003 (f32 projection aligned). These record the hard-to-reverse decisions; this spec operationalizes them.
- **Research basis.** `docs/research/kdbush-vs-rbush-for-clustering.md` established kdbush (static kd-tree) as the correct index for the batch-then-query clustering workload; this spec follows that conclusion (hand-ported kdbush, not rbush).
- **Smart-zone / multi-session note.** This is a 5-deliverable build (harness → kdbush → clustering → bindgen → optimize). Per the ask-matt main flow, it should be split into tracer-bullet tickets with blocking edges via `/to-tickets`, each `/implement`ed in a fresh context window, rather than attempted in one session.
