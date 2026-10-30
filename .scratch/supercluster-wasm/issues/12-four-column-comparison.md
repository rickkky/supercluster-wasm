# 12 — Four-column comparison matrix (js-worker column)

**What to build:** extend the bench to a four-column matrix — wasm-ffi,
wasm-worker, js-direct, js-worker — so the worker tax is compared
symmetrically (both implementations wired into a worker vs both direct).
Until now the worker-wired column compared "WASM behind IPC" against "JS
direct on the main thread" — an asymmetric comparison that conflates the
worker tax with the implementation difference. The js-worker column
completes the matrix: the headline pairwise (wasm-worker vs js-worker) is
deployment shape vs deployment shape. All four columns informational; the
FFI-direct gate is unchanged.

**Decisions (grilled with Ricky, Q1-Q10):**

- **Naming (Q1):** `wasm-ffi` (was FFI-direct), `wasm-worker` (was
  worker-wired), `js-direct` (was baseline), `js-worker` (new). "worker-wired"
  stays the umbrella term for any implementation behind a worker.
- **Kinds (Q2):** full mirror — load (GeoJSON) + getClusters_small +
  getClusters_world + getChildren + getLeaves. Symmetry is the point;
  microsecond drilldowns drowned by the IPC floor are themselves data.
- **Result return (Q3):** JS worker posts GeoJSON Feature arrays back
  as-is (structured-clone of the object graph) — that IS the js-worker
  return tax; no stringify/parse detour.
- **Placement (Q4):** bench-only (`bench/js/`), no production `js/` changes.
- **Discipline (Q5):** full mirror of the WASM harness —
  FFI_QUERY_WARMUP=200, fresh worker per load iteration, median-of-3.
- **Attribution (Q6):** untouched. If the four-column data shows an
  anomalous js-worker tax structure, that is a follow-up ticket.
- **Reporting (Q7):** unified js-direct denominator (three ratio columns:
  wasm-ffi/js, wasm-worker/js, js-worker/js) + headline pairwise
  wasm-worker vs js-worker.
- **Run (Q8):** full run (4 datasets × median-of-3), numbers in the Answer.
- **Smoke (Q9):** `test/js-worker-bench.test.js` (SMALL=1, Tier 3).
- **Gate (Q10):** unchanged — FFI-direct `load_coords` + the two viewport
  queries > 1.0.

**Timing conventions:** js-worker `load` timing INCLUDES the main-thread
structured-clone (it happens inside postMessage, within the timed region —
that is the tax being measured); GeoJSON generation sits outside the timed
region (mirrors the WASM harness's out-of-region flatten).

**Blocked by:** 11 (the four-column matrix builds on the transferred
`load_coords` worker-wired path and the final ticket-11 numbers).

**Status:** open

- [x] `bench/js/worker.js` — worker_threads port holding JS supercluster,
      promise-correlated protocol mirroring `bench/wasm/worker-thread.js`;
      handlers: load (GeoJSON), getClusters, getChildren, getLeaves
- [x] `bench/js/run.js` — harness with the full discipline
      (FFI_QUERY_WARMUP=200, fresh worker per load iteration, median-of-3);
      prints `JS_WORKER_SUMMARY_JSON` + `JS_WORKER_GEOMEAN_MS_PER_QUERY`
- [x] `bench/compare/run.js` — four columns; unified js-direct denominator
      (three ratio columns) + headline pairwise wasm-worker vs js-worker;
      COMPARISON_JSON extended; gate logic untouched
- [x] `test/js-worker-bench.test.js` — SMALL=1 smoke (Tier 3)
- [x] Full run; numbers + findings recorded in the Answer + map.md
- [x] No production `js/` changes; attribution harness untouched

## Answer

`resolved`. The four-column matrix is shipped and the full run is recorded.
**Headline finding: in deployment shape vs deployment shape (wasm-worker vs
js-worker), the WASM worker wins viewport queries by 2.5-11x geomean but
loses the GeoJSON load slightly (0.84) — and the js-worker column reveals
that the worker tax on the JS implementation itself is far heavier than on
WASM (query ratios 0.05-0.09 vs js-direct, vs wasm-worker's 0.14-1.00).**

**What shipped:**
- `bench/js/worker.js` — worker_threads port holding the reference
  `supercluster` npm package, promise-correlated protocol mirroring
  `bench/wasm/worker-thread.js`. Handlers: load (GeoJSON in, structured-
  cloned — that clone IS the js-worker input tax), getClusters /
  getChildren / getLeaves (GeoJSON Feature[] out, posted as-is — the
  object-graph clone on return IS the js-worker return tax),
  getClusterExpansionZoom. No `load_coords`/`getClustersIds` equivalent
  (the JS package has no pre-flattened or id-only API; a synthetic one
  would not be a faithful measurement).
- `bench/js/run.js` — the harness, full discipline mirror of the WASM
  harness (QUERY_WARMUP=200, fresh worker per load iteration, median-of-3,
  100-batch queries). Prints `JS_WORKER_SUMMARY_JSON` +
  `JS_WORKER_GEOMEAN_MS_PER_QUERY`. `pnpm bench:js`.
- `bench/compare/run.js` — four columns with a unified js-direct
  denominator (wasm-ffi/js, wasm-worker/js, js-worker/js) + the headline
  pairwise wasm-worker vs js-worker (js-worker as denominator, >1.0 =
  WASM worker faster). COMPARISON_JSON keys renamed to the Q1 vocabulary:
  `wasm_ffi` / `wasm_worker` / `js_worker` /
  `headline_wasm_worker_vs_js_worker`. Gate logic untouched.
- `test/js-worker-bench.test.js` (new SMALL=1 smoke) +
  `test/wasm-bench.test.js` (updated to the four-column COMPARISON_JSON).
  Tiers 1-3 green: 83 native + 9 wasm32 + 49 node (45 + 4 self-verify).
  (Post-review fixes: the count-parity gate now covers the js-worker
  column too — the orchestrator's parity promise is symmetric; the dead
  `createRequire` in bench/js/worker.js removed; the smoke-test failure
  labels name their column.)

**Full-run results (1M/6M x uniform/clustered, geomean ratios):**

| ratio vs js-direct | wasm-ffi | wasm-worker | js-worker |
|---|---|---|---|
| load (GeoJSON) | 0.92 | 0.10 | 0.13 |
| load_coords (fast path) | 1.63 | 1.22 | n/a |
| getClusters_small | 4.62 | 1.00 | 0.09 |
| getClusters_world | 1.63 | 0.14 | 0.06 |
| getChildren | 0.36 | 0.04 | 0.05 |
| getLeaves | 1.71 | 0.30 | 0.20 |

**Headline pairwise (wasm-worker vs js-worker, >1.0 = WASM worker
faster):** load 0.84, getClusters_small **11.43**, getClusters_world
**2.52**, getChildren 0.81, getLeaves 1.51.

**Findings:**

1. **The worker tax is NOT symmetric across implementations — the
   js-worker pays far more per query than the wasm-worker.** js-worker
   query ratios vs js-direct are 0.05-0.09 (11-18x slower than JS direct);
   wasm-worker's are 0.14-1.00. The mechanism: the js-worker must
   structured-clone the GeoJSON Feature object graph back on every query
   (per-feature objects + properties + coordinate arrays), while the
   wasm-worker returns compact typed arrays (copied once, transferred
   zero-copy). The return-shape difference is the dominant per-query tax
   differentiator — consistent with ticket 09's decode-layer attribution
   (the JS worker's "decode" is the clone itself).
2. **Deployment vs deployment, WASM wins where it matters most.** Viewport
   queries (the per-frame hot path): 9.7-15.2x faster per dataset on
   small bbox, 1.1-3.8x on world bbox, geomean 11.43 / 2.52. getLeaves
   1.51; getChildren 0.81 (microsecond scale, IPC floor both sides —
   parity within noise). The one loss: GeoJSON `load` 0.84 — the
   wasm-worker's GeoJSON path (structured-clone in + js-sys per-feature
   Reflect::get parse) is ~16% slower than the js-worker's (structured-
   clone in + native JS parse). This is the known parse-bound deficit
   (ticket 08), and the `load_coords` fast path is the answer: on the
   transferred fast path the wasm-worker's build (1315 ms geomean) is
   ~11.6x faster than the js-worker's GeoJSON build (15258 ms geomean
   `load`) — a comparison the js-worker cannot symmetrically answer
   (no flat API), recorded here as context, not a gated claim.
3. **The js-direct baseline remains the honest compute reference.**
   wasm-ffi gate: PASS (load_coords 1.63, small 4.62, world 1.63 — all
   > 1.0; run-to-run variance vs ticket 11's 1.50/4.23/1.81 is host
   noise, gate holds with margin on both runs).

**Methodology notes:** the js-worker `load` timing includes the main-thread
structured-clone (inside postMessage, within the timed region — the tax
being measured); GeoJSON generation sits outside timing (mirrors the WASM
harness's out-of-region flatten). Absolute js-worker load geomean 12768 ms
vs baseline 1747 ms (ratio 0.13 — the 6M GeoJSON clone into the worker
costs seconds per load). The js-worker column's `load_coords` is n/a by
design (Q2/Q3). No production `js/` changes; attribution harness untouched
(Q4/Q6).
