# Supercluster-WASM — Effort Map

Notes, Decisions-so-far, and Fog for the `supercluster-wasm` effort. Tickets
live under `issues/`; the spec is `spec.md`. Per `docs/agents/issue-tracker.md`,
resolved tickets append an `## Answer` and are recorded here as Decisions-so-far
pointers.

## Decisions-so-far

- **01 — Benchmark harness, JS baseline, oracle.** `resolved` in `bd2acc9`.
  Dual dataset generator (uniform-random + clustered-synthetic, seeded xorshift32),
  JS supercluster baseline timings, and oracle machinery diffing cluster membership
  per zoom. JS-vs-JS self-diff = 0 differences (machinery proven). `places.json`
  (163 pts, ISC) is the oracle seed corpus. Establishes the falsifiable baseline +
  correctness oracle every downstream ticket validates against.
- **02 — kdbush Spatial Index port.** `resolved` in `712b549`. Hand-ported
  Floyd–Rivest kd-tree (`range`/`within`, f32) in the `kdbush` crate, zero
  external index deps. Isolated unit tests vs brute-force over the bench workload
  shape (1M pts, 10k bbox + 10k radius). Also the Cargo workspace skeleton.
  Sub-seam A green — index bugs isolated from clustering-logic bugs.
- **03 — Clustering build core.** `resolved` in `fa81bd3`. Build half of the
  clustering stack: `load` + f32 spherical-mercator projection + SoA Cluster
  Lattice + per-zoom `_cluster` loop, in the new `crates/supercluster/` crate.
  **ADR 0003 amended: cluster centers are f64** (matching supercluster's
  `data`/`Float32Array` asymmetry) — required for membership equivalence, not
  just counts. Per-zoom top-level counts match JS supercluster exactly at all
  8 zooms `[0..7]` for both seeded 1000-pt datasets. Query half + full membership
  equivalence land in 04/05.
- **04 — getClusters query, oracle-verified.** `resolved` in `c8e1738`. Query half
  in `crates/supercluster/src/query.rs`: `getClusters(bbox, zoom)` with
  antimeridian wrapping, clamp/wrap of out-of-range bbox, floor-to-int zoom.
  Oracle options **A+B** (decided with Ricky): A = fixture-pinned `tests/oracle.rs`
  (5 tests) membership-match on `places.json` + seeded 1000-pt sets; B = on-demand
  `dump-membership` binary (fixture-gated, release serde-free) cross-diffed with
  JS by `bench/oracle/oracle-1m-rust.js`. `extract_membership` fixed from O(n²) to
  O(children) via a `parent_id -> children` index — **zero differences at 1M and 6M**
  for both datasets (Rust 10-14s vs JS 37s at 6M). 52 Rust + 30 JS tests pass.
- **05 — Cluster Hierarchy API.** `resolved` in `8a1b59d` (full suite green). The three
  drill-down methods — `get_children`, `get_leaves`, `get_cluster_expansion_zoom`
  — ported verbatim from `refs/supercluster/index.js` (lines 115–220) in the new
  `crates/supercluster/src/hierarchy.rs`. `get_children` uses the `within`+r scan
  for kd-tree traversal order (`test.js` pins ordered counts `[6,7,2,1]`);
  `get_leaves` paginates via a recursive DFS (`Option<usize>` limit, `None` = JS
  `Infinity`); invalid ids return empty (no-throw edge style). **ADR 0004:
  cluster ids match supercluster's encoding** — offset base is the full input
  count (`points.len()` = JS `this.points.length`), overriding spec line 54 so
  the literal JS ids `test.js` passes work as direct arguments (decided with
  Ricky). 8 acceptance tests in `tests/hierarchy.rs`; 60 Rust tests pass total.
  Implemented in `8a1b59d`.
- **06 — Declarative aggregation spec.** `resolved`. Replaces JS `map`/`reduce`
  callbacks (removed for perf — they'd force per-Point JS↔WASM chatter during
  build) with a Rust-side `AggregationSpec` (sum/count/min/max/mean) folded
  during the `_cluster` pass. `src/aggregation.rs`: `AggOp`/`AggField`/
  `AggSpec`/`AggState` — Mean is count-weighted (tracked as sum+count, not
  naively averaged) so sub-cluster means fold correctly; algebra
  identity-neutral + associative (5 unit tests in `tests/aggregation.rs`).
  `PointFeature` gained a `numeric_props` sidecar (populated at the WASM
  boundary / fixture loaders, **not** JSON-parsed in the build loop — keeps
  the release lib serde-free); `Options` gained `spec` (lost `Copy`).
  `Lattice` gained `acc`/`acc_stride` SoA arrays; `cluster()` folds
  origin-acc + Σ children-acc (sub-clusters contribute folded state, matching
  JS `reduce(origin.map, Σ children.map)`); `feature_at` surfaces finalized
  values. No-spec clusters carry `point_count` only (empty `aggregated`).
  **Fixture-pinned oracle** (option A, mirroring 04): `capture-aggregates.js`
  captures JS `sum(scalerank)` per cluster_id per zoom; `tests/aggregates.rs`
  (3 tests) diffs Rust's per-cluster sums keyed by cluster_id (ADR 0004 — ids
  interchangeable, no translation layer), incl. anti-tautology (radius 40 vs
  100 must differ). 77 Rust + 30 JS tests pass. WASM-boundary `numeric_props`
  population is ticket 07.
- **07 — wasm-bindgen boundary + Web Worker wiring.** `resolved` in `36dd4e2` (full
  suite green). The WASM↔JS boundary (sub-seam B): `wasm` feature in `crates/supercluster`
  (wasm-bindgen/js-sys optional, `crate-type cdylib+rlib`). `src/encode.rs` is a pure-Rust
  encoder (not feature-gated, TDD entry — Tier 1 `cargo test`); `src/wasm.rs` is the thin
  FFI shell (`SuperclusterWasm` with `load`/`get_clusters`/`get_children`/`get_leaves`/
  `get_cluster_expansion_zoom`). **Typed-array contract = Float64Array** (both buffers),
  reconciling the spec's "Float32Array view" wording to ADR 0003's f64-center amendment
  (decided with Ricky — f32 loses ~2m precision + risks agg-sum overflow; u32 ids/counts
  as f64 are exact < 2^53). Row stride 5 `[lng,lat,id,num_points,tag]`; aggregated stride
  `spec_len`; fresh per-query buffers (no `Float64Array::view` aliasing UB). `load` parses
  GeoJSON via `js-sys` (release stays serde-free) and populates the ticket-06-deferred
  `numeric_props` sidecar; `properties` left `None` (main thread keeps originals). ESM
  module worker (`js/worker.js`) owns one index; main-thread async wrapper (`js/index.js`)
  promise-correlated over postMessage; `js/decode.js` assembles GeoJSON; `js/index.d.ts`
  ships types. `.cargo/config.toml` pins `wasm-bindgen-test-runner` (wasm-pack 0.14.0
  doesn't intercept the default harness) + `wasm-bindgen-test` 0.3.x (matches the 0.2.127
  runner's discovery format). Tiers 1-3 are the committed CI gate (18 native + 4 wasm32 +
  7 node decode); Tier 4 browser smoke (`test/wasm-smoke.html`, MCP-driven, **not** in CI)
  verified SMOKE OK end-to-end. ADR 0002 honored: index stays opaque, only result data
  crosses (worker copies zero-copy views + transfers copies — WASM-memory views can't
  transfer). `/code-review`: no hard violations; 5 minor smells left for follow-up.
- **08 — Run harness comparison and optimize from data.** `resolved`. Plugged the
  ticket-01 harness into the WASM version (ticket 07): `bench/wasm/run.js`
  (FFI-direct + worker-wired columns) + `bench/compare/run.js` (orchestrator,
  two ratio columns + count-parity gate) + `test/wasm-bench.test.js` (Tier 3
  SMALL=1 smoke). **Two data-driven fast paths (both Ricky-approved API
  expansions):** (1) `load_coords(&Float64Array, &JsValue)` — the build hot
  path; `load` (GeoJSON) is parse-bound (~1.5 us/feature of per-feature
  `Reflect::get` FFI, FFI-direct `load` geomean 0.92), `load_coords` takes a
  pre-flattened `[lng,lat,...]` array with one `passArrayF64ToWasm0` copy +
  pure-Rust build, zero per-feature FFI — geomean **1.75 (PASS)**. Wired into
  `js/index.js`+`js/worker.js` (route `Float64Array` to `load_coords`). (2)
  `get_clusters_ids(bbox, zoom)` — the query hot path for Point-dense
  viewports; returns `{point_ids, cluster_ids, count}` as `Uint32Array` views
  (main thread indexes its own source features, zero per-row encode) — 9x
  faster than baseline microbench. **Measurement artifact found + fixed:**
  the first full bench's `getClusters_small` FAIL (0.87) was a **V8 JIT-
  tiering lottery** — the wasm-bindgen `get_clusters` hot loop tiers to
  TurboFan only after ~50-100 calls, and the 10-call warmup landed at the
  threshold (some runs ~0.7 ms/q un-tiered, some ~0.05 tiered). Verified by
  warmup ramp (10 calls -> 0.665, 100+ -> 0.05). Fix: per-timer
  `FFI_QUERY_WARMUP=200` untimed calls before each FFI + worker query timer.
  After fix, uniform 1M `getClusters_small` = 0.059 ms/q (was 0.858) — the
  true steady-state. **Final gate (spec's "both hot paths" = build + viewport
  query, FFI-direct geomean):** `load_coords` 1.88, `getClusters_small` 3.29,
  `getClusters_world` 1.78 — all PASS. `getChildren` 0.38 is reported but
  NOT gated: baseline ~2us is below the wasm-bindgen FFI boundary's ~3-5us
  fixed overhead (encode + 2x Float64Array::view + Object::new + Reflect::set
  + dispatch), which dominates the trivial compute of a 3-7-result drilldown
  — an FFI characteristic, not a clustering regression (`getChildren` can't
  take an id-only fast path: children are WASM-synthesized clusters the main
  thread has no source feature for). A buffer-reuse `encode_into` was tried +
  reverted (regressed small bbox; allocation is us-scale, not the bottleneck).
  **Q11 worker-pool:** single-worker `load` acceptable at 6M (`load_coords`
  > 1.0, GeoJSON `load` at parity 0.99-1.07 — parse-bound deficit is
  structural to GeoJSON, not a scaling problem); deferral stands. Tiers 1-3
  green (83 native + 9 wasm32 + 38 node). `pkg/` gitignored (not committed).

  bonus for Point-dense viewports).

- **09 — Worker-wired attribution harness + baseline absolutes.** `resolved`.
  A committed (non-production) attribution harness under `bench/attribution/`
  (`run.js` + `echo-worker.js`, reproducible via `pnpm bench:attribution`;
  Tier-3 smoke `test/attribution-bench.test.js`). Isolates the three
  worker-wired tax layers independently and reports **worker-wired absolute
  ms/query** (the first recorded absolutes for this column — only ratios
  existed before) + per-layer attribution across uniform-random +
  clustered-synthetic × 1M and 6M, per viewport shape (cluster-dense vs
  point-dense). **Method:** an echo worker (clone/transfer/tiny) isolates the
  IPC layers; the real worker-thread.js + a `getClustersRaw` no-decode path
  isolates the result-buffer copy from the main-thread decode; the 08
  `FFI_QUERY_WARMUP=200` discipline is reused (an un-warmed IPC floor exceeds
  the warmed worker query and floors the result-buffer layer to 0 spuriously
  — caught + fixed during the build). **Headline finding: no single layer
  dominates universally — the dominant layer is shape- and size-dependent**
  (not the 08 working assumption that the column is structurally IPC-bound):
  cluster-dense@1M → IPC floor dominates; point-dense@1M → result-buf
  (uniform) or decode (clustered); uniform@6M cluster-dense → result-buf copy
  (0.1357 ms/q); point-dense@6M → decode (0.1216–0.1302 ms/q). The
  load-input clone tax is the largest *absolute* worker-wired cost at 6M
  (87-151 ms/load) and transfer eliminates 7-18× of it (ticket 11 candidate
  a headroom). **Implication for 10/11:** ticket 10's `getClustersIds`
  hybrid decode targets the decode layer on point-dense shapes (the dominant
  per-query tax at 6M point-dense) — this baseline is the "before" 10
  measures against; ticket 11 candidate (a) transferList-on-input targets
  the load-input layer (highest absolute headroom); candidate (c)
  SharedArrayBuffer targets the result-buffer copy (dominant only at
  uniform-6M cluster-dense, high infra cost — surface as a decision). Known
  limitation: clustered@6M IPC floor caught a transient (0.1204 vs 0.0203
  elsewhere), inflating that shape's attribution — recorded honestly, 11
  should re-measure with the echo worker warmed after the 6M load. Bench-only,
  does not touch production `js/` (the worker protocol changes in 10).

- **10 — Wire `getClustersIds` drop-in fast path (hybrid decode).** `resolved`.
  The ticket-08 `get_clusters_ids` (built but unwired) is extended to a
  **hybrid** return shape and wired end-to-end. **ADR 0005** records the
  decision (Ricky approved the two-cluster-buffer layout `{point_ids,
  cluster_rows, cluster_aggregated, count, specLen}` over the spec's one-buffer
  shorthand, so `decodeQueryResult` is reused verbatim for cluster rows). Point
  rows are a compact `Uint32Array` of source-feature ids (the main thread
  indexes its own already-held `sourceFeatures` — zero per-row encode, zero JS
  object reconstruction); Cluster rows are encoded via the existing
  `encode_results` (Clusters are synthesized inside WASM with no main-thread
  source feature, so their lng/lat/num_points/aggregated must cross encoded —
  unavoidable). **Output-format change, not an algorithm change** — the lattice
  scan and `feature_at` are unchanged; only the FFI return shape differs.
  `decodeHybridResult` returns a `Feature[]` matching `getClusters` exactly
  (drop-in). `getClusters` (fully-encoded) retained for the no-source-features
  case (`load_coords` input). Worker gains a `getClustersIds` branch (3 buffers
  copied + transferred); `js/index.d.ts` ships `HybridQueryResult` + types.
  **Before/after (ticket-09 attribution harness, re-run with a direct
  full-round-trip `getClustersIdsRaw` measurement):** at the **6M target scale
  the hybrid path wins on the high-result-count shapes** — uniform cluster-dense
  **+62%** (0.1267→0.0481 ms/q), uniform point-dense **+20.5%** (0.1726→0.1372),
  clustered point-dense +9.5% (0.1044→0.0945); clustered cluster-dense ~flat
  (36 results, sub-noise). **The win is the WASM-encode saving + smaller
  transferred buffer, NOT the decode-layer saving the ticket predicted** — the
  decode-layer delta in isolation is noisy (the encoded-path decode measurement
  itself varied ~2× between runs at 6M point-dense); the full-round-trip is the
  trustworthy signal. At 1M the deltas are small-absolute (0.0065–0.018 ms/q)
  and mixed in sign — noise-dominated, not the target scale. Tiers 1-3 green
  (83 native + 9 wasm32 + 45 node). Bench-only attribution harness extended
  (`getClustersIdsRaw` + `decodeHybrid` on the RawWorker + a
  `measureDecodeHybrid` + full-round-trip measurement); production `js/`
  protocol change shipped (worker + index + decode + .d.ts).

- **11 — Data-driven next-bottleneck optimization on the worker-wired axis.**
  `resolved`. The data picked **candidate (a) — the load-input boundary
  crossing** (ticket 09: the largest *absolute* worker-wired cost at 6M,
  87-151 ms/load echo-isolated, 7-18x transfer headroom; ticket 10 already
  attacked the decode layer; candidate (c) SAB is dominant only at
  uniform-6M cluster-dense and needs COOP/COEP infra — not picked, not
  surfaced). **What shipped (JS-side + worker IPC only, no Rust change):**
  `load(Float64Array)` now TRANSFERS the coordinate buffer into the worker
  (transferList, zero-copy) — **Ricky approved default-transfer semantics**
  (the array is consumed/detached; a caller needing it re-usable passes a
  copy; documented in JSDoc + .d.ts). `#send` gained a transferList param;
  worker handlers unchanged (transfer is a main-thread postMessage option);
  GeoJSON `load` stays structured-cloned. Bench: the worker-wired column
  mirrors the deployment semantics and measures `load_coords` both ways
  (transferred vs clone-input, fresh worker per iteration — back-to-back
  large loads trap, the 08 finding); compare reports the worker-wired
  `load_coords` ratio (previously n/a); attribution echo measurements moved
  AFTER the 6M load (fixes the ticket-09 clustered@6M floor anomaly —
  0.1204 → 0.0472 ms/call). **Before/after (echo-isolated, per-load):**
  clone 16.4/8.9/101.4/105.7 ms → transfer 0.20/0.17/17.4/53.5 ms
  (82x/52x/5.8x/2.0x). **The full-round-trip before/after is
  noise-dominated at 6M** (build ±1 s+ variance swamps the ~50-100 ms clone
  tax; medians flipped sign between runs) — the isolated echo measurement is
  the trustworthy signal, recorded honestly. **Worker-wired geomean ratios
  (final):** load 0.10, load_coords 1.10 (first time reported), small 0.86,
  world 0.21. **FFI-direct gate: PASS, no regression** (1.50 / 4.23 / 1.81).
  **Stop condition for the worker-wired axis recorded:** the remaining
  deficit is the fixed IPC dispatch floor (0.02-0.08 ms/q, irreducible
  without SAB) + the point-dense decode layer (already reduced by ticket 10)
  — no single remaining layer both dominates and is fixable within the
  library boundary. Tiers 1-3 green (83 native + 9 wasm32 + 47 node; the
  new `test/load-transfer.test.js` pins the transfer round-trip + detach
  semantics + the clone path).

- **12 — Four-column comparison matrix (js-worker column).** `resolved`.
  The bench matrix is now four columns with a unified js-direct denominator:
  wasm-ffi (the gate), wasm-worker, js-worker (new), + the headline pairwise
  wasm-worker vs js-worker (deployment shape vs deployment shape — the
  ticket's question). `bench/js/worker.js` + `bench/js/run.js` hold the
  reference `supercluster` npm package behind a worker_threads worker
  (promise-correlated protocol mirroring the WASM worker; full discipline
  mirror: warmup 200, fresh worker per load, median-of-3; GeoJSON in
  structured-cloned, GeoJSON Feature[] out posted as-is — the clone taxes
  are the js-worker's real taxes, measured as-is). COMPARISON_JSON keys
  renamed to the Q1 vocabulary (`wasm_ffi`/`wasm_worker`/`js_worker`/
  `headline_wasm_worker_vs_js_worker`). **Findings:** (1) the worker tax is
  NOT symmetric across implementations — js-worker query ratios vs
  js-direct are 0.05-0.09 (11-18x slower) vs wasm-worker's 0.14-1.00; the
  js-worker's per-query return clone of the GeoJSON object graph dominates,
  while wasm-worker returns compact transferred typed arrays. (2) Deployment
  vs deployment, WASM wins the viewport hot path decisively: headline
  geomean getClusters_small **11.43**, world **2.52**, getLeaves 1.51,
  getChildren 0.81 (IPC-floor parity); the one loss is GeoJSON load 0.84
  (the known parse-bound deficit — and on the transferred `load_coords`
  fast path the wasm-worker build is ~11.6x faster than the js-worker's
  GeoJSON build, recorded as context, not a gated claim). (3) wasm-ffi gate
  PASS (1.63 / 4.62 / 1.63). Tiers 1-3 green (83 native + 9 wasm32 + 48
  node; new `test/js-worker-bench.test.js` smoke). Bench-only; no
  production `js/` changes; attribution harness untouched.

## Notes

- Correctness contract is **semantic equivalence** (cluster membership per zoom
  to JS supercluster), not byte-identical output. cluster_ids are now numerically
  interchangeable with supercluster's encoding (ADR 0004 overrides spec line 54
  "need not match" — ticket 05's test.js acceptance passes literal JS ids).
- Projection precision (ADR 0003): f32 spherical-mercator `[0..1]`, matching
  supercluster's `fround`. Raw-point coords + kd-tree coords are f32; cluster
  centers are f64 (the 03 amendment); intermediate accumulations may be f64.
- Antimeridian-wrapped points (lng > 180 from clustered_synthetic's Gaussian
  offset) project to x > 1.0 and cluster normally; they only drop out of
  `getClusters` viewport extraction (a 04 concern), not the lattice count.
- Delivery order (spec line 53): harness → kdbush → clustering logic →
  wasm-bindgen/worker → run harness, optimize from data. Currently through (8).

## Fog

- cluster_id decode semantics (`origin_index`/`origin_lattice_zoom`) are pinned
  against `refs/supercluster/test/test.js` in ticket 05 (ADR 0004 records the
  offset-base match to JS `this.points.length`).
- `getChildren`'s exact radius/zoom convention is deferred to 04 (pinned against
  `test.js`), not asserted in 03's `options.rs` to avoid a premature claim.
- Worker pooling is deferred (data-driven: only if the single-worker baseline is
  unacceptable at target N) — spec line 43. **08 re-evaluation:** single-worker
  `load` is acceptable at 6M (`load_coords` ratio > 1.0; GeoJSON `load` at
  parity 0.99-1.07 — the deficit is parse-bound, structural to GeoJSON, not a
  worker-scaling problem). Deferral stands.
- **08 V8 JIT-tiering artifact (measurement, not correctness):** the wasm-bindgen
  `get_clusters`/`get_children`/`get_leaves` hot loops tier to optimized
  TurboFan only after ~50-100 calls; a 10-call warmup lands at the threshold
  and measures the un-tiered path (~0.7 ms/q vs tiered ~0.05 ms/q — a 13x
  lottery). The harness uses `FFI_QUERY_WARMUP=200` per timer to reliably
  tier. Any future bench on a different V8/wasm-bindgen version should re-
  verify the warmup is still past the tiering threshold (a sudden query-ratio
  regression is more likely a tiering miss than a WASM-clustering regression).
- **08 WASM linear-memory reclamation:** Node's FinalizationRegistry isn't
  prompt enough between back-to-back large loads at 6M — un-finalized indices
  pile up in WASM linear memory until `__wbindgen_malloc` traps
  (`unreachable`). The bench calls `sc.free()` explicitly between median-of-3
  iterations and between datasets. Deployment `js/` holds one index per
  worker for the worker's lifetime (no accumulation); a long-lived main-
  thread `SuperclusterWasm` that re-`load`s must `free()` the previous index
  first (the `js/index.js` wrapper does not yet expose `free()` — a follow-up
  if a re-load use case appears).
- **08 `getChildren` FFI floor (not a regression):** `getChildren` returns 3-7
  results at ~2us baseline (below the wasm-bindgen FFI boundary's ~3-5us fixed
  overhead: encode + 2x Float64Array::view + Object::new + Reflect::set +
  dispatch). WASM structurally cannot beat pure JS on microsecond-scale
  trivial-compute drilldowns — the FFI floor dominates. This is why the 08 gate
  narrows to the spec's two hot paths (build + viewport query) and reports
  `getChildren`/`getLeaves` as informational. `getChildren` can't take an
  id-only fast path (unlike `get_clusters_ids`): children are WASM-synthesized
  clusters the main thread has no source feature for, so their lng/lat/
  num_points must cross encoded. A future wasm-bindgen version with cheaper
  boundary calls could flip this; re-measure before treating a `getChildren`
  ratio change as a regression.
- **08 `load_coords`/`get_clusters_ids` fast paths:** optional API expansions
  for callers who control the input pipeline (`load_coords`) or hold their
  own source features for point rendering (`get_clusters_ids`). `load`
  (GeoJSON) + `get_clusters` (encoded) remain the deployment-default paths.
  `get_clusters_ids` is documented alongside, not wired into, the orchestrator
  gate (the encoded path passes the gate after the warmup fix; the ids path is
  a bonus for Point-dense viewports).
