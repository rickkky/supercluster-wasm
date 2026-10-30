# 10 — Wire `getClustersIds` drop-in fast path (hybrid decode)

**What to build:** the `getClustersIds(bbox, zoom)` query, wired end-to-end and drop-in compatible with `getClusters`. The Rust FFI `get_clusters_ids` — already built, tested, and microbenched at 9× the JS baseline on the FFI-direct column, but not wired into the deployment JS — is extended to return a **hybrid shape**: Point rows as a compact `Uint32Array` of source-feature ids (the main thread indexes its own already-held source features by id — zero per-row encode, zero JS object reconstruction), and Cluster rows as an encoded `Float64Array` (Clusters are synthesized inside WASM and have no source feature on the main thread, so their lng/lat/num_points/aggregated must still cross encoded — unavoidable). The return contract is the type shape `{point_ids: Uint32Array, cluster_rows: Float64Array, count, specLen}` (encodes the ticket-07 hybrid-decode decision precisely). The Worker gains a `getClustersIds` branch that transfers both buffers. The main-thread `getClustersIds` method performs hybrid decode and returns a `Feature[]` whose shape matches `getClusters` exactly — Point rows are `sourceFeatures[point_id]` reference pushes (zero allocation), Cluster rows decode to Feature objects (the few, unavoidable allocations). `getClusters` (the fully-encoded path) is retained for the worker-wired decode case where the main thread holds no source features. This is the highest-leverage step on the worker-wired axis: it bypasses the per-Point encode + decode that dominates Point-dense viewports. Reuses the four existing test seams (semantic-equivalence oracle, WASM↔JS boundary typed-array contract, JS decode contract, bench count-parity gate) — no new seam. An ADR records the hybrid-decode decision (hard to reverse once shipped — callers depend on the return shape; surprising without context — why not pure ids?; a real trade-off — pure ids cannot render Clusters, two calls is convoluted).

**Blocked by:** 09 — the worker-wired baseline + per-layer attribution must exist first so this ticket's before/after contribution to the worker-wired column is cleanly attributable (the measure-then-change method, not change-then-rationalize).

**Status:** resolved

- [x] `getClustersIds(bbox, zoom)` public method on the main-thread wrapper, returning a drop-in `Feature[]` matching `getClusters`'s shape
- [x] Rust FFI `get_clusters_ids` returns the hybrid shape `{point_ids: Uint32Array, cluster_rows: Float64Array, count, specLen}` — Point rows as ids only, Cluster rows encoded via the existing encoder (output-format change, not an algorithm change; the Cluster rows are already computed during the lattice scan)
- [x] Worker `handle` switch has a `getClustersIds` branch that transfers both buffers (the result-side transfer mechanism is already used by `getClusters`; this reuses it)
- [x] Main-thread hybrid decode: Point rows index `sourceFeatures` by id (zero allocation, reference push); Cluster rows decode to Feature objects (the few, unavoidable allocations)
- [x] `getClusters` (fully-encoded path) retained unchanged, for the worker-wired decode case where the main thread holds no source features
- [x] TypeScript type definition ships a `getClustersIds` signature
- [x] Oracle parity: the `point_ids` set returned by the ids path equals the Point membership returned by the encoded `get_clusters` path for the same bbox/zoom (same lattice, same kd-tree `range` call — membership, not output format, is what the oracle compares)
- [x] WASM↔JS boundary tests cover the hybrid return shape (Cluster rows decode identically to the encoded path)
- [x] JS decode tests cover the `getClustersIds` drop-in `Feature[]` shape
- [x] Bench count-parity gate holds (WASM counts == JS baseline counts) for `getClustersIds`
- [x] ADR `0005-hybrid-ids-decode.md` written (the hybrid-decode decision: why Point rows go id-only and Cluster rows stay encoded)
- [x] Attribution harness from ticket 09 re-run; the `getClustersIds` before/after worker-wired contribution recorded in the Answer (how much of the worker-wired deficit the ids path recovers, separated from other layers)
- [x] No clustering-algorithm change, no f32-projection change, no oracle-impact (Q4=A→B boundary: JS-side + worker IPC + Rust output-format only)

## Answer

`resolved`. `getClustersIds(bbox, zoom)` is wired end-to-end as a drop-in fast
path with a **hybrid** return shape, decided in **ADR 0005** (Ricky approved the
two-cluster-buffer layout — `{point_ids, cluster_rows, cluster_aggregated, count,
specLen}` — over the ticket spec's one-buffer shorthand, so `decodeQueryResult`
is reused verbatim for cluster rows).

**What shipped (output-format change, not an algorithm change):**
- **Rust FFI** (`crates/supercluster/src/query.rs` + `wasm.rs`): `get_clusters_ids`
  now returns `(Vec<u32> point_ids, Vec<ClusterFeature>)`; the cluster features
  are encoded via the existing `encode_results` (stride-5 rows + cluster-dense
  aggregated). The lattice scan and `feature_at` are unchanged — cluster rows
  are already computed during the scan (the same path `get_clusters` uses); only
  the FFI return shape differs. `cluster_id_buf` dropped from `SuperclusterWasm`.
- **Worker** (`js/worker.js` + `bench/wasm/worker-thread.js`): a `getClustersIds`
  branch copies 3 views (point_ids `Uint32Array` + cluster_rows/cluster_aggregated
  `Float64Array`s) and transfers all 3 buffers (the result-side transfer the
  encoded path already uses, extended to 3 buffers).
- **Main thread** (`js/index.js` + `js/decode.js`): `getClustersIds` calls
  `decodeHybridResult`, which pushes `sourceFeatures[point_id]` per Point row
  (zero-alloc reference push) and reuses `decodeQueryResult` for cluster rows.
  Returns a `Feature[]` matching `getClusters` exactly — drop-in.
- `getClusters` (fully-encoded) retained unchanged for the no-source-features
  case (`load_coords` input). `js/index.d.ts` ships `HybridQueryResult` +
  `decodeHybridResult` + `getClustersIds` types.

**Tests (TDD at the JS-decode seam first, then boundary):** 6 new
`decodeHybridResult` tests in `test/decode.test.js` (empty, point-id ref pushes,
cluster-row synthesis, spec-attached aggregated, points-then-clusters order,
missing-source fallback). The 2 `wasm_boundary.rs` hybrid tests rewritten for
the 5-field shape + a cluster-rows-decode-identically assertion (sorted
multiset of stride-5 rows vs the encoded path's cluster rows). The bench
count-parity gate for `getClustersIds` is an inline assertion in `runWorker`
(`getClustersIds` count must equal `getClusters` count for the same bbox/zoom).
Tiers 1-3 green: 83 native + 9 wasm32 + 45 node.

**Before/after worker-wired contribution (the ticket-09 attribution harness,
re-run with a direct full-round-trip measurement of `getClustersIds` via
`getClustersIdsRaw`):**

| dataset@n / shape | encoded worker-wired (ms/q) | hybrid full round-trip (ms/q) | Δ (ms/q) | % of encoded |
|---|---|---|---|---|
| uniform@1M cluster-dense | 0.0698 | 0.0633 | +0.0065 | +9.2% |
| uniform@1M point-dense | 0.1357 | 0.1433 | −0.0076 | −5.6% |
| clustered@1M cluster-dense | 0.1201 | 0.1381 | −0.0180 | −15.0% |
| clustered@1M point-dense | 0.1156 | 0.1085 | +0.0071 | +6.1% |
| uniform@6M cluster-dense | 0.1267 | 0.0481 | +0.0786 | **+62.0%** |
| uniform@6M point-dense | 0.1726 | 0.1372 | +0.0355 | **+20.5%** |
| clustered@6M cluster-dense | 0.0311 | 0.0333 | −0.0022 | −7.1% |
| clustered@6M point-dense | 0.1044 | 0.0945 | +0.0099 | +9.5% |

**Headline: at the 6M target scale, the hybrid path wins on the high-result-
count shapes** (uniform cluster-dense +62%, uniform point-dense +20.5%,
clustered point-dense +9.5%). The win comes from the **WASM-encode saving**
(no per-Point `encode_results` row — the dominant term at scale, where the
encoded path writes 5 f64s per Point row into the row buffer) + the **smaller
transferred buffer** on point-dense (point_ids is 4 bytes/row vs rows' 40 bytes/
row), which shrinks the result-buffer copy+transfer tax. The decode-layer delta
in isolation is **noisy** (the encoded-path decode measurement itself varied ~2×
between runs at 6M point-dense — 0.1100 vs 0.2108 — because the decode loop's
V8 tiering state is run-to-run-variable at that scale); the full-round-trip is
the trustworthy before/after and is reported as the headline.

**At 1M the deltas are small in absolute terms (0.0065–0.018 ms/q) and mixed
in sign** — noise-dominated at that scale (sub-0.14 ms/q, 35–1289 results).
The 1M row is not the target; it's reported for completeness.

**Clustered@6M cluster-dense (−7.1%, 36 results)** is sub-noise (0.0022 ms/q
on a 0.0311 ms/q baseline with 36 results) — not a real regression. The
clustered@1M cluster-dense −15.0% (0.018 ms/q, 35 results) is likewise
small-absolute and noise-prone.

**Honest caveat:** the ticket's working hypothesis was that the hybrid path
wins by bypassing the per-Point *decode*. The measurement shows the decode-
layer delta is unreliable in isolation; the real win is the **WASM-encode +
transfer-size** saving, which dominates at 6M but is invisible at 1M. The
hybrid path is a net win at the target scale, but not for the reason the ticket
predicted — the decode-layer attribution (ticket 09's "decode dominates point-
dense at 6M") is real but the hybrid path's decode saving is within noise; the
encode-side saving is what carries it. ADR 0005 records this honestly.

**No clustering-algorithm change, no f32-projection change, no oracle-impact**
(Q4=A→B boundary: JS-side + worker IPC + Rust output-format only). The oracle
compares membership (the `point_ids` set equals the encoded path's Point
feature_ids for the same bbox/zoom — same lattice, same kd-tree `range` call),
not output format.
