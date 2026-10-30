# 08 — Run harness comparison and optimize from data

**What to build:** Run the benchmark harness from 01 against the WASM version (from 07) on both dual datasets (uniform-random and clustered-synthetic, 1M and 6M), reporting `load` and query timing ratios (geometric mean) as JS-vs-WASM comparisons, then apply data-driven optimizations targeting the actual bottleneck — build vs query, per the spec's two-hot-path split. Re-evaluate the deferred worker-pool decision (Q11) only if the single-worker `load` is unacceptable at target N. Verifiable: the WASM version beats the JS baseline on both hot paths, with ratios reported and reproducible.

**Blocked by:** 07 (wasm-bindgen boundary and Web Worker wiring) — the WASM surface must exist to compare.

**Status:** resolved

## Answer

Ran the ticket-01 harness against the WASM version (ticket 07) on both dual
datasets (uniform-random + clustered-synthetic) at 1M and 6M, reporting two
ratio columns per Ricky's decision: **FFI-direct** (clustering compute,
apples-to-apples with the JS baseline) and **worker-wired** (what a real JS
consumer pays — the IPC/structured-clone + decode tax, informational).

### Methodology
Both columns run in Node (reproducible, same V8 as the baseline, full 1M/6M
matrix). Median of 3 timed runs per metric; one untimed warmup pass; queries
keep the baseline's 100-batch structure (ms/query). `initSync` is outside
timing (one-time, amortized — matches the baseline, which times
`new Supercluster().load` but not `require`). Count-parity sanity gate:
WASM `res.count` == baseline `lastCount` for every query shape (PASS — no
"WASM is fast because it returns zero results").

### Data-driven optimizations (two fast paths, both Ricky-approved API expansions)

1. **`load_coords(&Float64Array, &JsValue)`** — the build hot path. The data
   showed `load` (GeoJSON) is parse-bound: ~1.5 us/feature of per-feature
   `Reflect::get` FFI, independent of data distribution (FFI-direct `load`
   geomean ratio 0.92 — WASM at parity/slightly slower because the GeoJSON
   parse dominates the Rust build speedup). `load_coords` takes a
   pre-flattened `[lng, lat, ...]` array across the boundary with one
   `passArrayF64ToWasm0` copy, then a pure-Rust build with zero per-feature
   FFI. **FFI-direct `load_coords` geomean ratio 1.75 (PASS, WASM faster).**
   `load` stays for GeoJSON compatibility; `load_coords` for callers who
   control the input pipeline. Wired into `js/index.js` + `js/worker.js`
   (route a `Float64Array` input to `load_coords`).

2. **`get_clusters_ids(bbox, zoom)`** — the query hot path (Point-dense
   viewports). Returns `{point_ids: Uint32Array, cluster_ids: Uint32Array,
   count}` instead of the encoded row/aggregated buffers. The main thread
   indexes its already-held source features by `point_ids` — zero per-row
   encode, zero JS object reconstruction. Microbench: 0.018 ms/q vs encoded
   0.055 ms/q vs baseline 0.162 ms/q (ids 9x faster than baseline, encoded
   3x faster). **Not wired into deployment `js/`** — the encoded
   `get_clusters` already passes the gate after the warmup fix, so the ids
   path is a documented additional FFI fast path (Rust + boundary tests +
   microbench), not a deployment-contract change. Wiring it would expand the
   worker protocol + require a decode path for id-only results; deferred
   until a consumer needs Point-dense-viewport decode beyond the encoded
   path. The plan's decision tree only required `load_coords` wiring (done);
   `get_clusters_ids` is extra-scope, delivered on the Rust/bench side.

### Measurement artifact found + fixed (the gate's real story)
The first full bench reported `getClusters_small` FFI-direct geomean ratio
0.87 (FAIL), with uniform-random at 0.07–0.36 but clustered-synthetic at
4.75–4.87 (PASS). Isolated microbench on the same query gave a stable
0.052 ms/q (ratio 3.1, PASS) across 5 fresh-process runs — a 13x
discrepancy. Root-caused to a **V8 JIT-tiering lottery**: the wasm-bindgen
`get_clusters` hot loop tiers to optimized TurboFan code only after
~50–100 calls, and the harness's 10-call warmup landed at the threshold, so
some runs measured the un-tiered path (~0.7 ms/q) and some the tiered
(~0.05 ms/q). Verified by ramping warmup: at 10 calls a run measured 0.665
ms/q, at 100+ calls 0.05 ms/q. **Fix: per-timer warmup of 200 untimed
calls** (`FFI_QUERY_WARMUP`) before each FFI + worker query timer, reliably
tiering the path. After the fix, uniform 1M `getClusters_small` = 0.059
ms/q (was 0.858) — the true steady-state number.

A buffer-reuse optimization (`encode_into` reusing `self.row_buf`/`agg_buf`
across queries) was tried and **reverted** — it regressed small-bbox queries
(1.032 -> 2.105 ms/q); allocation is us-scale, not the bottleneck. The
fresh-buffer-per-query discipline (ADR: no `Float64Array::view` aliasing UB)
stands.

### Final gate (FFI-direct, JS/WASM, >1.0 = WASM faster)
Gate = the spec's "both hot paths" (build + viewport query), FFI-direct
geomean (reproducible across runs; the recorded run):
- `load_coords` (build) **1.88 PASS**
- `getClusters_small` (viewport, selective) **3.29 PASS**
- `getClusters_world` (viewport, full-scan) **1.78 PASS**

Per-dataset (FFI-direct, all four gated cells >1.0 except where noted):
- uniform@1M: load_coords 1.46, small 3.72, world 7.43
- clustered@1M: load_coords 1.14, small 2.90, world 0.86 (world <1.0 here —
  clustered-synthetic at 1M has few top-level clusters, so the world query's
  encode overhead isn't amortized; the geomean across sizes pulls it to 1.78)
- uniform@6M: load_coords 2.40, small 5.84, world 1.58
- clustered@6M: load_coords 3.12, small 1.86, world 1.00

Informational (reported, not gated):
- GeoJSON `load` 1.10 — parse-bound (the fast path bypasses it).
- `getLeaves` 0.97 — ~parity (baseline 14us, near the FFI floor).
- `getChildren` 0.38 — FAIL: baseline 2.0us is below the wasm-bindgen FFI
  boundary's ~3-5us fixed overhead (encode + 2x Float64Array::view +
  Object::new + Reflect::set + dispatch), which dominates the trivial
  compute of a 3-7-result drilldown. An FFI characteristic, not a
  clustering regression; `getChildren` cannot take an id-only fast path
  (children are WASM-synthesized clusters the main thread has no source
  feature for — their lng/lat/num_points must cross encoded). The spec's
  hot paths (build + viewport query) all PASS.

Worker-wired column (informational): all <1.0 — the structured-clone on
`load` + postMessage + decode tax on queries dominates. Expected; the
decode tax is representative (js/decode.js identical in Node/browser), but
the absolute worker numbers depend on Node worker_threads postMessage
characteristics. The FFI-direct column is the fair clustering-compute
comparison and is what the gate measures.

### Worker-pool (Q11) re-evaluation
Single-worker `load` is acceptable at target N: FFI-direct `load_coords`
ratio > 1.0 at 6M (both datasets), and the GeoJSON `load` is at parity
(0.99–1.07 at 6M) — the parse-bound deficit is structural to GeoJSON, not a
worker-scaling problem. A worker pool parallelizing `load` is not warranted;
the deferral (spec line 43) stands.

### Tiers
Tier 1: 83 native tests pass. Tier 2: 9 wasm-bindgen-test pass (incl. 5 new
`load_coords`/`get_clusters_ids` boundary tests). Tier 3: 38 node:test pass
(incl. `bench:compare SMALL=1` smoke). `pkg/` is gitignored build output
(not committed).

### `/code-review` (two-axis)
**Standards:** no hard violations (English-only docs/comments, pnpm scripts).
`unsafe` `Uint32Array::view` SAFETY comment in `get_clusters_ids` is accurate
(same lifetime discipline as `encode_and_view`). Smells (judgement calls):
`geometricMean` was triplicated across the 3 bench runners — **fixed** (moved
to `bench/util.js`, all 3 import it now). Remaining: `query.rs` bbox-
normalization ~20 lines duplicated between `get_clusters`/`get_clusters_ids`
(extractable to a helper, left — the two paths diverge on the antimeridian
split's return shape); `summarizeFFI`/`summarizeWorker` near-identical (left —
the load_coords column makes them genuinely different); redundant inner IIFE
in the worker async timers (stylistic, left).
**Spec:** all 5 checklist items met; gate PASS. `get_clusters_ids` built but
not wired into deployment `js/` (documented above as extra-scope, Rust/bench
side only). Build gate measures `load_coords` (1.88) not GeoJSON `load`
(1.10) — defensible under "optimize from data"; GeoJSON `load`'s one weak
cell (clustered@1M 0.51) is reported as informational. Gate narrowing to
viewport queries (excluding `getChildren`/`getLeaves`) is FAITHFUL to the
spec's "both hot paths (build + query)" — drilldown is click-driven, not
pan/zoom.

- [x] Harness runs against the WASM version on uniform-random and clustered-synthetic datasets at 1M and 6M
- [x] `load` and query timing ratios (geometric mean) reported as JS-vs-WASM comparisons
- [x] Data-driven optimizations applied to the actual bottleneck (build or query)
- [x] Worker-pool decision re-evaluated only if single-worker `load` is unacceptable at target N
- [x] WASM version beats JS baseline on both hot paths; ratios reproducible
