// Worker-wired attribution harness (ticket 09).
//
// The spec's gate measures the FFI-direct column (clustering compute,
// apples-to-apples with JS) — it PASSes. The worker-wired column (what a real
// consumer pays — IPC + decode tax) is reported as informational and is
// entirely < 1.0, but nobody has yet decomposed *why*. This harness establishes
// that decomposition as a falsifiable, reproducible baseline before any
// worker-wired optimization is attempted, so ticket 10's `getClustersIds`
// contribution can be cleanly attributed (the before/after method).
//
// It isolates the three layers of tax the worker-wired column pays over the
// FFI-direct column, independently, per viewport shape, and reports
// **worker-wired absolute ms/query** (currently unrecorded anywhere in the
// repo; only ratios exist) plus a per-layer attribution, across the dual
// datasets (uniform-random + clustered-synthetic) at 1M and 6M.
//
// The three layers (ticket 09 spec):
//
//   (1) load-input boundary crossing — the coordinate array crossing
//       main-thread -> worker: structured-clone copy vs transfer. Measured
//       once per load (not per query) as `load_input_clone_ms` /
//       `load_input_transfer_ms`, at the dataset's actual coordinate-array
//       byte size (n * 2 * 8 bytes). The echo worker moves a buffer of that
//       exact size round-trip; the clone variant is the tax the deployment
//       `load` pays today, the transfer variant is the ticket-11 headroom.
//
//   (2) result-buffer boundary crossing — the WASM `Float64Array::view` ->
//       fresh-copy -> transfer path. Measured per query as the worker's
//       copy-views-then-transfer step, isolated from the WASM compute and the
//       main-thread decode: the harness asks the real worker-thread.js to run
//       `get_clusters` but times only the post-back + transfer, and separately
//       measures a raw echo_transfer of the result's byte size to subtract
//       the fixed IPC floor. The difference is the copy tax.
//
//   (3) main-thread decode — per-Cluster Feature object allocation vs per-Point
//       zero-allocation source-feature reference. Measured per query by running
//       `decodeQueryResult` on a captured result, isolated from IPC and WASM.
//       Reported per viewport shape: Point-dense (decode is cheap — Point rows
//       are zero-alloc references) vs cluster-dense (decode allocates 3 objects
//       per Cluster row).
//
// Methodology: median of 3 timed runs per metric; one untimed warmup pass;
// queries keep the 100-batch structure (report ms/query) with the 08
// FFI_QUERY_WARMUP untimed calls before each worker query timer (V8 tiering —
// see the 08 ticket answer). Absolute ms/query is the headline; the per-layer
// attribution sums to the worker-wired total per viewport shape.
//
// Output: plain text to stdout, plus `ATTRIBUTION_JSON=` on stderr for capture.
// Run with: pnpm bench:attribution   (SMALL=1 for a 10k smoke pass)
//
// Bench-only: does NOT touch production `js/`. One-shot attribution script
// discipline — the worker protocol will change in ticket 10, so instrumenting
// production code now would be immediately stale.

import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { initSync, SuperclusterWasm } from '../../pkg/supercluster.js';
import { uniformRandom, clusteredSynthetic, loadCenters } from '../datasets/generate.js';
import { parseSizes, timeMs, geometricMean } from '../util.js';
import { DEFAULT_OPTIONS } from '../oracle/config.js';
import { decodeQueryResult, decodeHybridResult } from '../../js/decode.js';

const SIZES = parseSizes(process.env.SMALL ? [10_000] : [1_000_000, 6_000_000]);
const OPTIONS = DEFAULT_OPTIONS; // matches refs/supercluster/bench.js (maxZoom 6)

// Two viewport shapes: cluster-dense (low zoom / world bbox — decode allocates
// 3 objects per Cluster row) and Point-dense (high zoom / small bbox — Point
// rows are zero-alloc source-feature references). The decode-layer attribution
// is reported per shape, not averaged into noise (ticket 09 spec).
const SHAPES = [
  { key: 'cluster_dense', label: 'cluster-dense', bbox: [-180, -90, 180, 90], zoom: 0 },
  { key: 'point_dense', label: 'point-dense', bbox: [-90, 25, -70, 45], zoom: 6 },
];

// Initialize the WASM module once, outside any timing. The FFI-direct path is
// used here only to *produce* a built index + capture result buffers for the
// isolated decode-layer measurement — the FFI-direct timings themselves live
// in bench/wasm/run.js (ticket 08); this harness does not re-measure them.
initSync({
  module: new WebAssembly.Module(
    readFileSync(new URL('../../pkg/supercluster_bg.wasm', import.meta.url)),
  ),
});

// Per-timer warmup for the worker's WASM query hot loop (mirrors the 08
// FFI_QUERY_WARMUP constant — the worker's get_clusters crosses the same FFI
// boundary, and the decode/result-layer measurements must sit on the tiered
// path or they'd measure V8's un-tiered slow path, not the worker-wired tax).
const FFI_QUERY_WARMUP = 200;

// --- Echo worker client (IPC-layer isolation) -----------------------------
//
// A thin wrapper around the echo worker (./echo-worker.js). Each call is
// promise-correlated by id, mirroring the deployment main-thread wrapper.

class EchoWorker {
  constructor() {
    this.#worker = new Worker(new URL('./echo-worker.js', import.meta.url));
    this.#pending = new Map();
    this.#nextId = 1;
    this.#ready = new Promise((resolve, reject) => {
      const onReady = (msg) => {
        if (msg && msg.type === 'ready') {
          this.#worker.off('message', onReady);
          resolve();
        }
      };
      this.#worker.on('message', onReady);
      this.#worker.once('error', (err) => reject(err));
    });
    this.#worker.on('message', (msg) => this.#onmessage(msg));
  }

  get ready() {
    return this.#ready;
  }

  // Structured-clone a buffer in (copy), post back (copy). Returns the size
  // echoed, for an assert. This is the load-input clone tax, in isolation.
  // `buf` is a plain ArrayBuffer (not a Node Buffer — pooled Buffer backing
  // memory can't be transferred, and clone semantics are cleaner on a raw
  // ArrayBuffer).
  echoClone(buf) {
    return this.#send('echo_clone', { buf }, false);
  }

  // Transfer a buffer in (zero-copy move), transfer back (zero-copy move).
  // The caller must re-create the buffer each call (transfer empties the
  // source). This is the load-input transfer headroom, in isolation.
  echoTransfer(buf) {
    return this.#send('echo_transfer', { buf }, true);
  }

  // Near-zero-byte round trip — the per-call IPC dispatch floor.
  echoTiny() {
    return this.#send('echo_tiny', {}, false);
  }

  terminate() {
    this.#worker.terminate();
    this.#pending.clear();
  }

  // `transfer` controls whether `payload.buf` is moved (transferList) or
  // copied (structured clone). Clone is the deployment `load` tax; transfer
  // is the ticket-11 headroom.
  #send(type, payload, transfer) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const transferList = transfer && payload.buf ? [payload.buf] : [];
      this.#worker.postMessage({ id, type, ...payload }, transferList);
    });
  }

  #onmessage(msg) {
    if (!msg || typeof msg.id !== 'number') return;
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    p.resolve(msg);
  }

  #worker;
  #pending;
  #nextId;
  #ready;
}

// --- Real worker client (result-layer isolation) -------------------------
//
// A thin wrapper around the real worker-thread.js, with one extra capability:
// a `getClustersRaw` method that resolves the *raw* transferred buffers
// (count + rows + aggregated + specLen) WITHOUT running decodeQueryResult —
// so the harness can time the result-buffer boundary crossing (post-back +
// transfer) and the main-thread decode as two separate measurements. The
// deployment WorkerWired wrapper (bench/wasm/run.js) folds these into one
// `getClusters` call; the attribution harness must split them.

class RawWorker {
  constructor() {
    this.#worker = new Worker(new URL('../wasm/worker-thread.js', import.meta.url));
    this.#pending = new Map();
    this.#nextId = 1;
    this.#sourceFeatures = [];
    this.#specFieldNames = [];
    this.#ready = new Promise((resolve, reject) => {
      const onReady = (msg) => {
        if (msg && msg.type === 'ready') {
          this.#worker.off('message', onReady);
          resolve();
        }
      };
      this.#worker.on('message', onReady);
      this.#worker.once('error', (err) => reject(err));
    });
    this.#worker.on('message', (msg) => this.#onmessage(msg));
  }

  get ready() {
    return this.#ready;
  }

  async load(points, options = {}) {
    const res = await this.#send('load', { points, options });
    if (!res.ok) throw new Error(res.error);
    const feats = Array.isArray(points)
      ? points
      : Array.isArray(points?.features)
        ? points.features
        : [];
    this.#sourceFeatures = feats.filter((f) => f && f.geometry);
    this.#specFieldNames = Array.isArray(options?.aggregation?.fields)
      ? options.aggregation.fields.map((f) => f.name)
      : [];
  }

  // Run `getClusters` on the worker and resolve the RAW transferred result
  // (the buffers land owned on the main thread, but decode is NOT run). This
  // isolates the result-buffer boundary crossing (post-back + transfer) from
  // the main-thread decode.
  async getClustersRaw(bbox, zoom) {
    const res = await this.#send('getClusters', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return res;
  }

  // Run `getClustersIds` (ticket 10 hybrid path) on the worker and resolve the
  // RAW transferred result (point_ids + cluster_rows + cluster_aggregated +
  // count + specLen, decode NOT run). Isolates the result-buffer boundary
  // crossing for the hybrid path from the main-thread hybrid decode. The
  // result-buffer copy tax is ~identical to the encoded path (same copy-views-
  // then-transfer step, one extra Uint32Array copy for point_ids — negligible
  // vs the Float64Array copies), so the attribution harness measures the
  // DECODE-layer delta (the layer 10 targets), not the result-buffer layer.
  async getClustersIdsRaw(bbox, zoom) {
    const res = await this.#send('getClustersIds', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return res;
  }

  // Run decode on a captured raw result — isolates the main-thread decode from
  // IPC and WASM compute. `raw` is the object resolved by getClustersRaw.
  decode(raw) {
    return decodeQueryResult(raw, this.#sourceFeatures, this.#specFieldNames);
  }

  // Run the hybrid decode (ticket 10) on a captured raw hybrid result —
  // isolates the main-thread hybrid decode from IPC and WASM compute. `raw`
  // is the object resolved by getClustersIdsRaw. Point rows are zero-alloc
  // source-feature reference pushes; cluster rows decode via the existing
  // decodeQueryResult. The delta vs `decode(raw)` on the same shape is the
  // before/after worker-wired contribution ticket 10 attributes.
  decodeHybrid(raw) {
    return decodeHybridResult(raw, this.#sourceFeatures, this.#specFieldNames);
  }

  terminate() {
    this.#worker.terminate();
    this.#pending.clear();
  }

  #send(type, payload) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, type, ...payload });
    });
  }

  #onmessage(msg) {
    if (!msg || typeof msg.id !== 'number') return;
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    p.resolve(msg);
  }

  #worker;
  #pending;
  #nextId;
  #sourceFeatures;
  #specFieldNames;
  #ready;
}

// --- timing helpers --------------------------------------------------------

async function timeMsAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

function medianOf3(a, b, c) {
  const arr = [a, b, c].sort((x, y) => x - y);
  return arr[1];
}

// --- layer (1): load-input boundary crossing ------------------------------

// Measure the structured-clone tax of moving the coordinate array
// main -> worker, at the dataset's actual byte size. The coordinate array is
// n*2 Float64 = n*16 bytes (mirrors the deployment `load` path, which
// structured-clones the GeoJSON feature array — a larger object graph; the
// flat-coord byte size is the lower bound, reported as such). Median of 3.
async function measureLoadInputClone(echo, bytes) {
  // Warmup + per-run fresh ArrayBuffer (clone copies, so the source survives).
  const buf = new ArrayBuffer(bytes);
  await echo.echoClone(buf);
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = await timeMsAsync(() => echo.echoClone(buf));
    samples.push(ms);
  }
  return medianOf3(...samples);
}

// Measure the transfer tax of moving the same byte size main -> worker
// (zero-copy move). The transfer headroom for the ticket-11 candidate.
// Median of 3; a fresh ArrayBuffer per run (transfer empties the source).
async function measureLoadInputTransfer(echo, bytes) {
  await echo.echoTransfer(new ArrayBuffer(bytes));
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = await timeMsAsync(() => echo.echoTransfer(new ArrayBuffer(bytes)));
    samples.push(ms);
  }
  return medianOf3(...samples);
}

// The per-call IPC dispatch floor (near-zero-byte round trip). Subtracted
// from every per-query worker-wired measurement so the decode/result layers
// are not inflated by fixed dispatch overhead. Warmed up with the same
// FFI_QUERY_WARMUP discipline as the worker queries — the first few echo
// round trips are cold (V8 JIT + worker boot), and an un-warmed floor would
// exceed the worker-wired per-query (which is itself warmed), making the
// result-buffer layer floor to 0 spuriously.
async function measureIpcFloor(echo) {
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await echo.echoTiny();
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = await timeMsAsync(() => echo.echoTiny());
    samples.push(ms);
  }
  return medianOf3(...samples);
}

// --- layer (2): result-buffer boundary crossing ----------------------------

// Measure the worker's copy-views-then-transfer step per query, isolated from
// the WASM compute and the main-thread decode. The harness asks the real
// worker to run `getClusters` (WASM compute + copy + transfer + post-back) and
// subtracts: the FFI-direct WASM compute time (measured here, same index) and
// the IPC floor (measured above). What remains is the result-buffer copy +
// transfer tax. Median of 3 over 100-batch query loops.
async function measureResultBoundary(raw, sc, shape, ipcFloor) {
  const { bbox, zoom } = shape;
  // Warmup the worker's WASM query hot loop (V8 tiering — see 08 answer).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await raw.getClustersRaw(bbox, zoom);

  // Worker-wired per-query: WASM compute + copy + transfer + post-back, minus
  // the IPC floor. Batches of 100; median of 3.
  const batches = 100;
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = await timeMsAsync(() => {
      return (async () => {
        for (let i = 0; i < batches; i++) await raw.getClustersRaw(bbox, zoom);
      })();
    });
    samples.push(ms / batches);
  }
  const workerWiredPerQuery = medianOf3(...samples);

  // FFI-direct WASM compute per query (same index, same shape): the clustering
  // compute the worker-wired column pays for *underneath* the IPC tax. The
  // result-boundary layer = workerWired - ffiCompute - ipcFloor (floored at 0).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) sc.get_clusters(bbox, zoom);
  const ffiSamples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = timeMs(() => {
      let l;
      for (let i = 0; i < batches; i++) l = sc.get_clusters(bbox, zoom);
      return l;
    });
    ffiSamples.push(ms / batches);
  }
  const ffiComputePerQuery = medianOf3(...ffiSamples);

  // The hybrid path's full worker-wired round-trip (ticket 10 before/after).
  // `getClustersIdsRaw` runs the hybrid FFI (no per-Point encode; cluster rows
  // encoded) + the worker's copy-views-then-transfer (3 buffers: point_ids +
  // cluster_rows + cluster_aggregated) + post-back. This is the *whole* ids-path
  // worker-wired cost — the before/after compares this against the encoded
  // path's `workerWiredPerQuery` above, not just the decode layer. The decode-
  // layer delta alone is incomplete: the ids path also saves the per-Point WASM
  // encode and transfers a smaller buffer on point-dense shapes.
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await raw.getClustersIdsRaw(bbox, zoom);
  const hybridSamples = [];
  for (let r = 0; r < 3; r++) {
    const { ms } = await timeMsAsync(() => {
      return (async () => {
        for (let i = 0; i < batches; i++) await raw.getClustersIdsRaw(bbox, zoom);
      })();
    });
    hybridSamples.push(ms / batches);
  }
  const workerWiredHybridPerQuery = medianOf3(...hybridSamples);

  // Layer 2 (result-buffer copy + transfer) is isolated by SUBTRACTION, not a
  // direct measurement: workerWired − ffiCompute − ipcFloor. Layers 1 and 3
  // are measured directly (echo worker / decode on a captured result); layer 2
  // cannot be, because timing the worker's internal copy-views-then-transfer
  // step would require instrumenting production `js/worker.js`, which the
  // ticket-09 constraint ("does not touch production `js/`") forbids. The
  // residual is therefore fragile — a mis-measured floor can collapse it to 0
  // (see the clustered@6M anomaly in the Answer). Ticket 11 will either re-
  // measure with the floor folded into the real-worker pass, or pursue the
  // direct-instrumentation path once the worker protocol changes (ticket 10).
  const resultBoundary = Math.max(0, workerWiredPerQuery - ffiComputePerQuery - ipcFloor);
  return { workerWiredPerQuery, workerWiredHybridPerQuery, ffiComputePerQuery, ipcFloor, resultBoundary };
}

// --- layer (3): main-thread decode -----------------------------------------

// Measure `decodeQueryResult` on a captured raw result, isolated from IPC and
// WASM compute. The decode allocates 3 objects per Cluster row (properties +
// geometry + the Feature wrapper) but only pushes a reference per Point row
// (zero alloc). Reported per viewport shape (cluster-dense vs point-dense).
async function measureDecode(raw, shape) {
  const { bbox, zoom } = shape;
  // Capture one raw result (post-warmup, so it's the tiered-path shape).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await raw.getClustersRaw(bbox, zoom);
  const rawSample = await raw.getClustersRaw(bbox, zoom);
  const count = rawSample.count | 0;

  // Decode is synchronous; time it over a batch, median of 3.
  const batches = 100;
  const samples = [];
  // Warmup decode itself (V8 tiers the decode loop too).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) raw.decode(rawSample);
  for (let r = 0; r < 3; r++) {
    const { ms } = timeMs(() => {
      let l;
      for (let i = 0; i < batches; i++) l = raw.decode(rawSample);
      return l;
    });
    samples.push(ms / batches);
  }
  return { decodePerQuery: medianOf3(...samples), count };
}

// Measure `decodeHybridResult` (ticket 10) on a captured raw hybrid result,
// isolated from IPC and WASM compute. The hybrid decode pushes a zero-alloc
// source-feature reference per Point row (vs the encoded path's per-row
// typed-array decode), so on Point-dense shapes it should beat the encoded
// decode; on cluster-dense shapes the cluster rows still decode identically
// (same decodeQueryResult call), so the delta is ~zero there. The before/after
// decode-layer delta = `measureDecode` − `measureDecodeHybrid` per shape.
async function measureDecodeHybrid(raw, shape) {
  const { bbox, zoom } = shape;
  // Capture one raw hybrid result (post-warmup, so it's the tiered-path shape).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await raw.getClustersIdsRaw(bbox, zoom);
  const rawSample = await raw.getClustersIdsRaw(bbox, zoom);
  const count = rawSample.count | 0;

  // Decode is synchronous; time it over a batch, median of 3.
  const batches = 100;
  const samples = [];
  // Warmup decode itself (V8 tiers the decode loop too).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) raw.decodeHybrid(rawSample);
  for (let r = 0; r < 3; r++) {
    const { ms } = timeMs(() => {
      let l;
      for (let i = 0; i < batches; i++) l = raw.decodeHybrid(rawSample);
      return l;
    });
    samples.push(ms / batches);
  }
  return { decodePerQuery: medianOf3(...samples), count };
}

// --- per-dataset runner ---------------------------------------------------

async function runDataset(name, points) {
  const n = points.length;
  const bytes = n * 2 * 8; // Float64 coordinate array byte size (n*2*8)
  console.log(`\n=== ${name} (${n.toLocaleString()} points, ${bytes.toLocaleString()} B coord array) ===`);

  // Real worker for the result + decode measurements. The 6M load runs FIRST
  // (ticket 09's recorded limitation: the echo worker's floor measurement ran
  // before the 6M load stressed the worker-thread pool, and its median landed
  // high on clustered@6M — 0.1204 vs 0.0203 elsewhere — inflating that
  // shape's attribution). Warming the pool with the real load first keeps the
  // echo floor in its normal range.
  const raw = new RawWorker();
  await raw.ready;
  // Warmup load (one untimed).
  {
    const warmupWorker = new RawWorker();
    await warmupWorker.ready;
    await warmupWorker.load(points, OPTIONS);
    await warmupWorker.getClustersRaw(SHAPES[0].bbox, SHAPES[0].zoom);
    await warmupWorker.getClustersRaw(SHAPES[1].bbox, SHAPES[1].zoom);
    warmupWorker.terminate();
  }
  await raw.load(points, OPTIONS);

  // Echo worker for the IPC-layer measurements — AFTER the 6M load (see above).
  const echo = new EchoWorker();
  await echo.ready;

  const ipcFloor = await measureIpcFloor(echo);
  const loadCloneMs = await measureLoadInputClone(echo, bytes);
  const loadTransferMs = await measureLoadInputTransfer(echo, bytes);
  echo.terminate();

  console.log(`  IPC dispatch floor:       ${ipcFloor.toFixed(4)} ms/call`);
  console.log(`  load-input clone (${bytes.toLocaleString()} B):  ${loadCloneMs.toFixed(2)} ms`);
  console.log(`  load-input transfer (same): ${loadTransferMs.toFixed(2)} ms (headroom for ticket 11)`);

  // FFI-direct index (same data) for the WASM-compute subtraction in layer 2.
  const sc = new SuperclusterWasm();
  sc.load(points, OPTIONS);

  const shapes = [];
  for (const shape of SHAPES) {
    const res = await measureResultBoundary(raw, sc, shape, ipcFloor);
    const dec = await measureDecode(raw, shape);
    const decHybrid = await measureDecodeHybrid(raw, shape);
    const decodeDelta = dec.decodePerQuery - decHybrid.decodePerQuery;
    const totalAttributed = res.resultBoundary + dec.decodePerQuery + ipcFloor;
    // Before/after worker-wired: the encoded path's full round-trip
    // (workerWiredPerQuery) vs the hybrid path's full round-trip
    // (workerWiredHybridPerQuery, measured directly via getClustersIdsRaw —
    // includes the hybrid FFI + 3-buffer copy+transfer + post-back, before
    // decode). The decode-layer delta is reported separately for attribution.
    const workerWiredDelta = res.workerWiredPerQuery - res.workerWiredHybridPerQuery;
    const workerWiredPct = (workerWiredDelta / res.workerWiredPerQuery) * 100;
    console.log(`  [${shape.label}] worker-wired: ${res.workerWiredPerQuery.toFixed(4)} ms/q (${dec.count} results)`);
    console.log(`    ├─ WASM compute (FFI):     ${res.ffiComputePerQuery.toFixed(4)} ms/q`);
    console.log(`    ├─ result-buffer copy+tx:  ${res.resultBoundary.toFixed(4)} ms/q`);
    console.log(`    ├─ main-thread decode:     ${dec.decodePerQuery.toFixed(4)} ms/q (encoded) → ${decHybrid.decodePerQuery.toFixed(4)} ms/q (hybrid) [decode Δ ${decodeDelta.toFixed(4)}]`);
    console.log(`    └─ IPC dispatch floor:     ${ipcFloor.toFixed(4)} ms/q  (attributed sum: ${totalAttributed.toFixed(4)} ms/q)`);
    console.log(`      → getClustersIds full round-trip: ${res.workerWiredHybridPerQuery.toFixed(4)} ms/q (Δ ${workerWiredDelta.toFixed(4)} ms/q = ${workerWiredPct.toFixed(1)}% of encoded worker-wired)`);
    shapes.push({
      shape: shape.key,
      label: shape.label,
      bbox: shape.bbox,
      zoom: shape.zoom,
      result_count: dec.count,
      worker_wired_ms_per_query: Number(res.workerWiredPerQuery.toFixed(4)),
      worker_wired_hybrid_ms_per_query: Number(res.workerWiredHybridPerQuery.toFixed(4)),
      worker_wired_delta_ms_per_query: Number(workerWiredDelta.toFixed(4)),
      ffi_compute_ms_per_query: Number(res.ffiComputePerQuery.toFixed(4)),
      result_buffer_ms_per_query: Number(res.resultBoundary.toFixed(4)),
      decode_ms_per_query: Number(dec.decodePerQuery.toFixed(4)),
      decode_hybrid_ms_per_query: Number(decHybrid.decodePerQuery.toFixed(4)),
      decode_delta_ms_per_query: Number(decodeDelta.toFixed(4)),
      ipc_floor_ms_per_query: Number(ipcFloor.toFixed(4)),
      attributed_sum_ms_per_query: Number(totalAttributed.toFixed(4)),
    });
  }

  sc.free();
  raw.terminate();

  return {
    dataset: name,
    n,
    coord_array_bytes: bytes,
    load_input_clone_ms: Number(loadCloneMs.toFixed(2)),
    load_input_transfer_ms: Number(loadTransferMs.toFixed(2)),
    ipc_floor_ms_per_query: Number(ipcFloor.toFixed(4)),
    shapes,
  };
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log('supercluster-wasm — worker-wired attribution harness (ticket 09)');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}`);

  const centers = loadCenters();
  const results = [];
  for (const n of SIZES) {
    const uniform = uniformRandom(n, 1234);
    results.push(await runDataset('uniform-random', uniform));

    const clustered = clusteredSynthetic(n, 1234, centers);
    results.push(await runDataset('clustered-synthetic', clustered));
  }

  // Per-layer attribution summary: which layer dominates, per dataset/size/
  // viewport shape. The dominant layer = the max-attributed layer per shape.
  console.log('\n=== Per-layer attribution (which layer dominates) ===');
  console.log(
    pad('dataset@n / shape', 34) +
      pad('result-buf', 12) +
      pad('decode', 12) +
      pad('ipc-floor', 12) +
      pad('dominant', 14),
  );
  console.log('-'.repeat(84));
  for (const r of results) {
    for (const s of r.shapes) {
      const layers = {
        'result-buf': s.result_buffer_ms_per_query,
        decode: s.decode_ms_per_query,
        'ipc-floor': s.ipc_floor_ms_per_query,
      };
      const dominant = Object.entries(layers).sort((a, b) => b[1] - a[1])[0][0];
      console.log(
        pad(`${r.dataset}@${r.n.toLocaleString()} / ${s.label}`, 34) +
          pad(s.result_buffer_ms_per_query.toFixed(4), 12) +
          pad(s.decode_ms_per_query.toFixed(4), 12) +
          pad(s.ipc_floor_ms_per_query.toFixed(4), 12) +
          pad(dominant, 14),
      );
    }
  }

  // Load-input layer summary (per-load, not per-query).
  console.log('\n=== Load-input boundary crossing (per-load, not per-query) ===');
  console.log(
    pad('dataset@n', 30) +
      pad('coord bytes', 14) +
      pad('clone ms', 12) +
      pad('transfer ms', 14) +
      pad('clone/transfer', 16),
  );
  console.log('-'.repeat(86));
  for (const r of results) {
    const ratio = r.load_input_transfer_ms > 0
      ? r.load_input_clone_ms / r.load_input_transfer_ms
      : null;
    console.log(
      pad(`${r.dataset}@${r.n.toLocaleString()}`, 30) +
        pad(r.coord_array_bytes.toLocaleString(), 14) +
        pad(r.load_input_clone_ms.toFixed(2), 12) +
        pad(r.load_input_transfer_ms.toFixed(2), 14) +
        pad(ratio == null ? 'n/a' : ratio.toFixed(2) + 'x', 16),
    );
  }

  // Machine-readable payload on stderr for capture / the ticket answer.
  console.error('\nATTRIBUTION_JSON=' + JSON.stringify(results, null, 0));
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

await main();
// Force exit: the worker_threads listeners keep the event loop alive after
// terminate() (mirrors bench/wasm/run.js). All output emitted; exit cleanly.
process.exit(0);
