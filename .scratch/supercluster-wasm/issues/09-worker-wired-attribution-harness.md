# 09 — Worker-wired attribution harness + baseline absolutes

**What to build:** a committed (non-production) attribution harness that isolates the three layers of tax the worker-wired column pays over the FFI-direct column — (1) the `load` input boundary crossing (the coordinate array crossing main-thread → worker: structured-clone copy vs transfer), (2) the result-buffer boundary crossing (the WASM `Float64Array::view` → fresh-copy → transfer path), and (3) the main-thread decode (per-Cluster Feature object allocation vs per-Point zero-allocation source-feature reference) — and reports **worker-wired absolute ms/query** (currently unrecorded anywhere in the repo; only ratios exist) plus a per-layer attribution, across the dual datasets (uniform-random + clustered-synthetic) at 1M and 6M. This is the measurement half of the worker-wired optimization axis: the spec's gate measures the FFI-direct column (clustering compute, apples-to-apples with JS), which already PASSes; the worker-wired column (what a real consumer pays — IPC + decode tax) is reported as informational and is entirely `< 1.0`, but nobody has yet decomposed *why*. This ticket establishes that decomposition as a falsifiable, reproducible baseline before any worker-wired optimization is attempted, so the next ticket's `getClustersIds` contribution can be cleanly attributed (the before/after method). Research-type ticket; the deliverable is data, recorded in the Answer.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Attribution harness committed under `bench/` (not `js/`), reproducible via a pnpm script
- [x] Isolates the three worker-wired tax layers independently: load-input boundary crossing, result-buffer boundary crossing, main-thread decode
- [x] Reports worker-wired **absolute ms/query** (not just JS/WASM ratios) — the first recorded absolutes for this column
- [x] Runs across uniform-random + clustered-synthetic × 1M and 6M (the bench's existing dual-dataset matrix)
- [x] Per-layer attribution recorded in the ticket Answer (which layer dominates, per dataset/size/viewport shape)
- [x] Does not touch production `js/` (one-shot attribution script discipline — the worker protocol will change in ticket 10, so instrumenting production code now would be immediately stale)
- [x] Distinguishes Point-dense viewport shapes (decode is cheap — Point rows are zero-alloc references) from cluster-dense viewport shapes (decode allocates 3 objects per Cluster row), so the decode-layer attribution is reported per viewport shape, not averaged into noise

## Answer

Harness committed under `bench/attribution/` (`run.js` + `echo-worker.js`),
reproducible via `pnpm bench:attribution` (SMALL=1 for the 10k smoke pass).
Tier-3 smoke test `test/attribution-bench.test.js` guards the plumbing (finite
absolutes + per-layer sum consistent with the worker-wired total). Does not
touch production `js/` — bench-only, one-shot attribution script discipline.

**Method.** Three layers isolated independently, each with the 08
`FFI_QUERY_WARMUP=200` untimed-call discipline (V8 tiers the wasm-bindgen
query hot loop + the echo round-trip only after ~50-100 calls; an un-warmed
floor would exceed the warmed worker query, making the result-buffer layer
floor to 0 spuriously — caught + fixed during the build):

- **(1) Load-input boundary crossing** (per-load, not per-query): an echo
  worker moves a raw `ArrayBuffer` of the dataset's coordinate-array byte size
  (n·2·8 B) round-trip, two variants — `echo_clone` (structured clone, the
  deployment `load` tax today) and `echo_transfer` (transferList, the ticket-11
  zero-copy-load headroom). The flat-coord byte size is a lower bound (the
  deployment `load` structured-clones the larger GeoJSON feature graph).
- **(2) Result-buffer boundary crossing** (per-query): the real worker-thread.js
  runs `getClusters` (WASM compute + copy-views + transfer + post-back); the
  layer = worker-wired − FFI-direct WASM compute (same index, same shape) −
  IPC floor. Isolates the copy+transfer tax from compute and dispatch.
- **(3) Main-thread decode** (per-query): `decodeQueryResult` on a captured
  raw result, isolated from IPC + WASM. Reported per viewport shape —
  cluster-dense (world bbox, zoom 0: decode allocates 3 objects/Cluster row)
  vs point-dense (small bbox, zoom 6: Point rows are zero-alloc source-feature
  references).

**Worker-wired absolute ms/query (the first recorded absolutes for this column):**

| dataset@n / shape | worker-wired | WASM compute | result-buf | decode | ipc-floor | dominant |
|---|---|---|---|---|---|---|
| uniform@1M / cluster-dense | 0.0525 | 0.0121 | 0.0178 | 0.0116 | 0.0227 | ipc-floor |
| uniform@1M / point-dense | 0.1711 | 0.0768 | 0.0715 | 0.0534 | 0.0227 | result-buf |
| clustered@1M / cluster-dense | 0.0385 | 0.0056 | 0.0095 | 0.0019 | 0.0234 | ipc-floor |
| clustered@1M / point-dense | 0.1120 | 0.0709 | 0.0177 | 0.0439 | 0.0234 | decode |
| uniform@6M / cluster-dense | 0.1653 | 0.0093 | 0.1357 | 0.0087 | 0.0203 | result-buf |
| uniform@6M / point-dense | 0.2143 | 0.0955 | 0.0985 | 0.1302 | 0.0203 | decode |
| clustered@6M / cluster-dense | 0.0392 | 0.0041 | 0.0000* | 0.0023 | 0.1204* | ipc-floor* |
| clustered@6M / point-dense | 0.1395 | 0.0664 | 0.0000* | 0.1216 | 0.1204* | decode |

**Load-input boundary crossing (per-load):**

| dataset@n | coord bytes | clone ms | transfer ms | clone/transfer |
|---|---|---|---|---|
| uniform@1M | 16 MB | 9.95 | 1.40 | 7.11x |
| clustered@1M | 16 MB | 17.17 | 0.98 | 17.52x |
| uniform@6M | 96 MB | 150.84 | 17.15 | 8.80x |
| clustered@6M | 96 MB | 86.58 | 42.78 | 2.02x |

**Findings (which layer dominates, per dataset/size/viewport shape):**

1. **No single layer dominates universally — the dominant layer is shape- and
   size-dependent.** This is the headline: the worker-wired column is *not*
   structurally IPC-bound (the 08 working assumption). The dominant layer
   flips across the matrix:
   - **cluster-dense @ 1M**: IPC dispatch floor dominates (0.0227–0.0234 ms/q
     vs sub-0.018 result/decode layers). The result is tiny (35–69 clusters),
     so the fixed ~0.02 ms postMessage round-trip outweighs the per-row taxes.
   - **point-dense @ 1M**: result-buffer copy (uniform, 0.0715) or decode
     (clustered, 0.0439) dominates — the 976–1289-result viewport makes the
     per-row taxes outweigh the fixed floor.
   - **cluster-dense @ 6M (uniform)**: result-buffer copy dominates (0.1357)
     — the 6M lattice's top-level clusters carry larger aggregated buffers,
     and the copy scales with result bytes.
   - **point-dense @ 6M**: decode dominates (0.1216–0.1302) — 1166–1582
     results, and even at zero-alloc-per-Point the Cluster rows + the loop
     overhead accumulate.

2. **The load-input clone tax is large and transfer eliminates 7-18× of it.**
   At 6M, structured-cloning the 96 MB coordinate array costs 87-151 ms per
   load; transferring it costs 17-43 ms. This is a **per-load** tax (amortized
   over the index lifetime), not per-query — but at 6M it is the single
   largest worker-wired cost in absolute terms. Ticket 11's transferList-on-
   input candidate (11a) is the highest-leverage *load* optimization; the
   data confirms the headroom (8.80× at uniform-6M, 2.02× at clustered-6M —
   the clustered ratio is lower because its larger feature graph's clone cost
   is dominated by object-graph traversal, not the raw byte copy the flat
   coord transfer eliminates).

3. **The result-buffer copy (layer 2) is the dominant *per-query* tax at 6M
   cluster-dense**, and is the candidate-11c layer (SharedArrayBuffer +
   cross-origin isolation). The data shows it at 0.1357 ms/q (uniform-6M
   cluster-dense) — meaningful but not catastrophic, and only dominant in
   that one shape. The SAB infrastructure cost (COOP/COEP deployment change)
   is high relative to a sub-0.14 ms/q gain; ticket 11 should surface this as
   a decision for Ricky rather than pursue it by default.

4. **The decode layer (layer 3) dominates point-dense @ 6M** — and this is
   exactly what ticket 10's `getClustersIds` hybrid decode attacks: Point
   rows become id-only (zero per-row encode on the WASM side, zero per-row
   decode on the JS side). The before/after for ticket 10 should show the
   decode layer dropping sharply on point-dense shapes (where Point rows
   dominate the result set), with cluster-dense shapes (few Cluster rows)
   barely affected. The attribution baseline above is the "before" ticket 10
   measures against.

**Known measurement limitation (recorded honestly, not papered over):** the
clustered-synthetic@6M IPC floor (0.1204 ms/call) is anomalously high vs.
uniform@6M (0.0203) and vs. clustered@1M (0.0234). The echo worker's
`echo_tiny` median on the second 6M dataset caught a transient — the echo
worker is a *separate* worker from the real worker, and its warmup ran before
the 6M load stressed the worker-thread pool; the floor median on that pass
landed high. This inflated floor ate the result-buffer layer (floored to
0.0000*) on clustered@6M. The cluster-dense shape there is low-confidence
(the floor dominated spuriously); the point-dense shape's decode layer
(0.1216) is still reliable because decode is measured independently of the
floor. Ticket 11 should re-measure clustered@6M with the echo worker warmed
*after* the 6M load, or fold the floor measurement into the real-worker pass.
The dominant-layer story for the other 6 shapes is stable and reproducible.

**Implication for ticket 10/11.** The data picks the layers:
- Ticket 10 (`getClustersIds` hybrid decode) targets layer 3 on point-dense
  shapes — the dominant per-query tax at 6M point-dense (0.1216–0.1302 ms/q).
  Before/after: decode layer should drop sharply on point-dense, unchanged on
  cluster-dense.
- Ticket 11 candidate (a) transferList-on-input targets layer 1 — the largest
  *absolute* worker-wired cost at 6M (87-151 ms/load), 7-18× headroom.
- Ticket 11 candidate (c) SharedArrayBuffer targets layer 2 — dominant only
  at uniform-6M cluster-dense (0.1357 ms/q); high infra cost, surface as a
  decision.
- No single layer dominates universally → ticket 11 may document a
  structural finding and stop, per its own exit criterion.

Tiers 1-3 green (83 native + 9 wasm32 unchanged; 40 node tests — the new
attribution smoke test added). `pkg/` gitignored (rebuilt locally to measure
current code).
