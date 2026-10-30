# 11 — Data-driven next-bottleneck optimization on the worker-wired axis

**What to build:** using the per-layer attribution from ticket 09 and the `getClustersIds` before/after from ticket 10, attack whichever remaining layer dominates the worker-wired column. Static-analysis candidates, ranked by prior expectation but decided by the data: (a) the `load` input boundary crossing — the coordinate array is currently structured-cloned into the worker (a 48MB copy at 6M points) then copied *again* into WASM linear memory by `load_coords`; the result-side transfer mechanism is already in use but the input-side is not, so a transferList on the `Float64Array` input eliminates the first copy (zero-copy load); (b) the main-thread decode on cluster-dense viewports — per-Cluster Feature object allocation (3 objects + 1 coordinate array per Cluster row), relevant only when the viewport is cluster-dense (low zoom / world bbox); (c) the result-buffer copy — the WASM `Float64Array::view` borrows WASM linear memory and cannot be transferred directly, so the Worker copies it before transfer; eliminating this needs `SharedArrayBuffer` + cross-origin isolation headers (COOP/COEP), a deployment-infrastructure change with high cost and uncertain reward. The data picks the layer. If no single layer dominates — i.e. the worker-wired column is structurally IPC-bound rather than dominated by one fixable tax — document that finding in the Answer and stop (do not chase diminishing returns). Re-run the gate after any change. May be re-split into per-layer tickets once 09/10 data identifies the dominant layer.

**Blocked by:** 10 — the dominant remaining layer is only knowable after the `getClustersIds` path is wired and its before/after measured; attacking a layer before that would conflate the ids-path win with the next optimization's win.

**Status:** resolved

- [x] The dominant remaining worker-wired layer is identified from ticket 09's attribution + ticket 10's before/after (not from prior expectation)
- [x] That layer is attacked, OR — if no single layer dominates — the structural-IPC-bound finding is documented in the Answer with the per-layer numbers that justify stopping
- [x] Worker-wired ratios re-run and reported (absolute ms/query + JS/WASM ratio)
- [x] Q4=A→B boundary held: JS-side + worker IPC changes first; Rust internal refactor allowed but no clustering-algorithm change; no SIMD (Q4=C excluded — ADR 0003's f32 projection is oracle-pinned, SIMD risks boundary-point membership); no oracle impact
- [x] If the chosen layer is the result-buffer copy (candidate c), the SharedArrayBuffer + cross-origin-isolation infrastructure cost is surfaced as a decision for Ricky before proceeding (it is a deployment-environment change, not a library change)
- [x] No regression on the FFI-direct gate (the spec's two hot paths — build + viewport query — must stay PASS; this ticket operates on the worker-wired column, not the gated column)

## Answer

`resolved`. **The data picked candidate (a) — the load-input boundary crossing —
and it is attacked: the `load(Float64Array)` fast path now TRANSFERS the
coordinate buffer into the worker (transferList, zero-copy) instead of
structured-cloning it.** Ricky approved the default-transfer semantics (the
array is consumed; a caller who needs it re-usable passes a copy).

**Why (a), from the data (not prior expectation):**
- Ticket 09's attribution: the load-input clone is the largest *absolute*
  worker-wired cost at 6M (87-151 ms per load, echo-isolated), with 7-18x
  transfer headroom — and it is a pure JS-side + worker-IPC change (Q4=A→B).
- Ticket 10 already attacked the decode layer (the dominant per-query tax on
  point-dense shapes): the hybrid path's win is the WASM-encode + transfer-
  size saving, shipped.
- Candidate (c) (result-buffer copy / SharedArrayBuffer) is dominant only at
  uniform-6M cluster-dense (0.1357 ms/q in the 09 baseline) and requires the
  COOP/COEP deployment-infrastructure change — the data does not pick it, so
  the SAB decision is NOT surfaced to Ricky (the ticket's condition for
  surfacing it — "if the chosen layer is (c)" — is not met). If a future
  ticket wants the last per-query tax at 6M cluster-dense, the SAB + COOP/COEP
  cost must be weighed then.

**What shipped (JS-side + worker IPC only; no Rust change, no algorithm
change, no oracle impact):**
- `js/index.js`: `#send` gains a transferList parameter; `load(Float64Array)`
  posts `{points, options}` with `[points.buffer]` — the buffer detaches on
  the main thread (documented in the JSDoc + `.d.ts`: the array is consumed).
  GeoJSON `load` stays structured-cloned (the clone of the feature graph is
  unavoidable there — the worker needs the full objects for `load`).
- `js/worker.js` + `bench/wasm/worker-thread.js`: no handler change needed
  (the worker already routes Float64Array to `load_coords`; transfer is a
  main-thread postMessage option). Protocol comment updated.
- `js/index.d.ts`: the `load(Float64Array)` overload documents the transfer/
  detach semantics.
- `bench/wasm/run.js`: the worker-wired column mirrors the deployment
  semantics (transferred input) and now measures `load_coords` both ways —
  transferred (after) vs clone-input (before) — fresh worker per iteration
  (back-to-back large loads in one worker pile up WASM linear memory and
  trap, the 08 finding).
- `bench/compare/run.js`: the worker-wired column reports the `load_coords`
  ratio (previously "n/a").
- `bench/attribution/run.js`: the echo-worker measurements (IPC floor +
  load-input clone/transfer) now run AFTER the 6M load warms the worker pool
  — the ticket-09 recorded limitation (clustered@6M floor 0.1204 vs 0.0203
  elsewhere) is fixed, exactly as that ticket's Answer prescribed ("Ticket 11
  should re-measure clustered@6M with the echo worker warmed *after* the 6M
  load"): the re-run floors are 0.0229-0.0750 ms/call, same order of
  magnitude across all datasets.

**Test (TDD at the worker-protocol seam):** `test/load-transfer.test.js`
(3 tests) — a Float64Array posted WITH a transferList builds via `load_coords`
and answers queries (encoded + hybrid count parity), the source buffer
detaches (transfer semantics pinned), the no-transferList clone path
still works (source survives), and the production `js/index.js` wrapper
statically pins its transferList postMessage (the browser-style module
worker over pkg/ can't run under plain Node worker_threads; the runtime
mechanics are pinned on the faithful worker port). Tiers 1-3 green:
**83 native + 9 wasm32 + 47 node** (45 + 2 new).

**Before/after (the isolated layer — attribution echo worker, per-load):**

| dataset@n | coord bytes | clone ms (before) | transfer ms (after) | clone/transfer |
|---|---|---|---|---|
| uniform@1M | 16 MB | 16.36 | 0.20 | 81.8x |
| clustered@1M | 16 MB | 8.87 | 0.17 | 52.2x |
| uniform@6M | 96 MB | 101.39 | 17.42 | 5.8x |
| clustered@6M | 96 MB | 105.69 | 53.46 | 2.0x |

The echo transfer numbers include the `new ArrayBuffer(96MB)` allocation in
the timed region (a fresh buffer per run — transfer empties the source), so
they are an upper bound on the transfer tax; the real path's allocation sits
outside the load call.

**The full-round-trip before/after is noise-dominated at 6M and is reported
honestly as unresolvable there:** the worker-wired `load_coords` full
round-trip (build ~2-4 s at 6M) has ±1 s+ run-to-run variance, which
swamps the ~50-100 ms clone tax. The committed harness's fresh-worker
clone-vs-transfer medians flipped sign between runs (uniform@6M: 4422→2705
in one run, 2395→2604 in the next). At 1M the round-trip is ~440 ms and the
delta is invisible (437 vs 438 ms). The isolated echo measurement above is
the trustworthy signal for this layer; the full-round-trip medians are in
the harness output for completeness (WORKER_SUMMARY_JSON now carries
`load_coords_ms` + `load_coords_clone_ms`). (A /code-review catch: the
harness's clone arm originally posted through the same transferred path as
the transfer arm — both arms measured transfer, which is why the medians
flipped sign; the clone arm now posts with `transfer: false`, and the
flip-sign anomaly is attributable to build-time variance, not the input
crossing.)

**Worker-wired ratios re-run (final compare, JS/WASM geomean, >1.0 = WASM
faster):** load 0.10, **load_coords (transferred fast path) 1.10** (first
time reported for this column), getClusters_small 0.86, getClusters_world
0.21, getChildren 0.05, getLeaves 0.22. Absolute worker-wired `load_coords`
geomean 1181 ms (clone-input 1120 ms — the round-trip noise caveat above
applies). Per-dataset worker-wired load_coords ratios: 1.05 / 0.94 / 0.99 /
1.50. (Post-review confirmation run, clone arm fixed: worker geomean
`load_coords` 1249 ms vs `load_coords_clone` 1304 ms — transfer ~4% ahead
on the round-trip geomean, direction consistent, magnitude still inside
the build-time variance.)

**FFI-direct gate: PASS, no regression** (the gated column, untouched by
this ticket): load_coords 1.50, getClusters_small 4.23, getClusters_world
1.81 — all > 1.0. (Run-to-run variance on this host moved the absolute
ratios vs the ticket-08 record — 1.72/5.61/2.36 then, 1.50/4.23/1.81 now —
but the gate holds with margin on both runs.)

**IPC-floor re-measurement (the ticket-09 limitation, fixed):** floors now
0.0253 / 0.0229 / 0.0750 / 0.0472 ms/call (uniform@1M / clustered@1M /
uniform@6M / clustered@6M) — clustered@6M is no longer the anomalous
0.1204. The per-layer attribution table is now stable across all 8 shapes;
the dominant layer remains shape-dependent (ipc-floor on cluster-dense,
decode on point-dense — the latter already attacked by ticket 10's hybrid
path).

**Not pursued (recorded, not chased):** candidate (c) SharedArrayBuffer —
dominant only at uniform-6M cluster-dense, high infra cost (COOP/COEP),
data does not pick it. The remaining worker-wired deficit is now spread
across the fixed IPC dispatch floor (0.02-0.08 ms/q, irreducible without
SAB) and the decode layer on point-dense shapes (already reduced by the
ticket-10 hybrid path). No single remaining layer both dominates and is
fixable within the library boundary — the structural finding the ticket's
exit criterion describes, recorded here as the stop condition for the
worker-wired axis.

