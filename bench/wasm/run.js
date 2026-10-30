// WASM harness (ticket 08): FFI-direct + worker-wired columns.
//
// Mirrors `bench/baseline/run.js` so the two are directly comparable. Two
// columns are reported because Ricky's decision (this session) was to measure
// BOTH the FFI-direct path (clustering compute — apples-to-apples with the JS
// baseline) AND the worker-wired path (what a real JS consumer pays, surfacing
// the IPC/decode tax):
//
//   - FFI-direct: `SuperclusterWasm` in Node directly. `initSync` is outside
//     timing (one-time, amortized — matches the baseline, which times
//     `new Supercluster().load` but not `require('supercluster')`). This is
//     the fair clustering-compute comparison.
//   - Worker-wired: a Node `worker_threads` adapter (`./worker-thread.js`)
//     running the real deployment worker logic + the real `js/decode.js`.
//     Captures the points-clone on `load` (structured clone of the feature
//     array into the worker) and the decode tax on queries. Labeled caveat:
//     Node `worker_threads` postMessage differs from the browser, but the
//     decode tax (the dominant term) is representative because `js/decode.js`
//     is identical, and structured-clone is the same algorithm in both.
//
// Methodology: median of 3 timed runs per metric; one untimed warmup pass
// first; queries keep the baseline's 100-batch structure (report ms/query).
// Count-parity sanity gate: WASM `res.count` must equal the JS baseline
// `lastCount` for each query shape; mismatches are surfaced (not asserted
// here — the compare orchestrator asserts) so this runner can be run alone.
//
// Output: plain text to stdout, plus `WASM_SUMMARY_JSON=` / `WASM_GEOMEAN_MS_PER_QUERY=`
// (FFI-direct) and `WORKER_SUMMARY_JSON=` / `WORKER_GEOMEAN_MS_PER_QUERY=` (worker-wired)
// on stderr for the compare orchestrator. Run with: pnpm bench:wasm
//
// Sizes are configurable via SIZES=<n> env var (comma-separated), defaulting
// to 1M and 6M. Set SMALL=1 to run a quick smoke pass at 10k instead.

import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { initSync, SuperclusterWasm } from '../../pkg/supercluster.js';
import { uniformRandom, clusteredSynthetic, loadCenters } from '../datasets/generate.js';
import { parseSizes, timeMs, geometricMean } from '../util.js';
import { DEFAULT_OPTIONS } from '../oracle/config.js';
import { decodeQueryResult, decodeHybridResult } from '../../js/decode.js';

const SIZES = parseSizes(process.env.SMALL ? [10_000] : [1_000_000, 6_000_000]);

const OPTIONS = DEFAULT_OPTIONS; // matches refs/supercluster/bench.js (maxZoom 6)

// A small bbox centered on a populated region (US east coast) and the
// whole-world bbox, to exercise both selective and full-scan query paths.
const SMALL_BBOX = [-90, 25, -70, 45];
const WORLD_BBOX = [-180, -90, 180, 90];

// Row stride of the WASM `rows` buffer (mirrors encode.rs / js/decode.js):
// [lng, lat, id, num_points, tag]; tag 0.0 = point, 1.0 = cluster.
const ROW_STRIDE = 5;
const TAG_CLUSTER = 1.0;

// Initialize the WASM module once, outside any timing. `initSync` over a
// `WebAssembly.Module` compiled from the file bytes — no fetch, no async.
initSync({
  module: new WebAssembly.Module(
    readFileSync(new URL('../../pkg/supercluster_bg.wasm', import.meta.url)),
  ),
});

// --- FFI-direct column ----------------------------------------------------

function timeLoadFFI(points) {
  // `new` + `load` inside timing; `initSync` already done above. The GeoJSON
  // parse crosses the boundary inside `load` (per-feature Reflect::get FFI).
  const { result: sc, ms } = timeMs(() => {
    const s = new SuperclusterWasm();
    s.load(points, OPTIONS);
    return s;
  });
  return { sc, elapsed: ms };
}

// Pre-flatten the dataset's coordinates into a single Float64Array once,
// outside timing. The fast path measures `load_coords` (one copy + pure-Rust
// build, zero per-feature FFI) against the same JS baseline `load` — so the
// ratio isolates the GeoJSON-parse cost the fast path removes.
function flattenCoords(points) {
  const feats = Array.isArray(points) ? points : Array.isArray(points?.features) ? points.features : [];
  let n = 0;
  for (const f of feats) if (f && f.geometry) n += 2;
  const flat = new Float64Array(n);
  let i = 0;
  for (const f of feats) {
    if (!f || !f.geometry) continue;
    const c = f.geometry.coordinates;
    flat[i++] = c[0];
    flat[i++] = c[1];
  }
  return flat;
}

function timeLoadCoordsFFI(flat) {
  // `new` + `load_coords` inside timing. The single `passArrayF64ToWasm0`
  // copy + the pure-Rust build are both inside the timed region — this is the
  // fair comparison to JS `Supercluster.load` (which also builds from the
  // already-in-JS-heap points array, not from the array's construction).
  const { result: sc, ms } = timeMs(() => {
    const s = new SuperclusterWasm();
    s.load_coords(flat, OPTIONS);
    return s;
  });
  return { sc, elapsed: ms };
}

// Warmup call count for the WASM FFI query timers. V8 tiers a wasm-bindgen
// query's hot loop to optimized TurboFan code only after enough calls — the
// tiering threshold for the FFI-crossing `get_clusters` sits near ~50-100
// calls, so the harness's single 10-call warmup pass lands right at the edge
// and sometimes measures the un-tiered path (~0.7 ms/q vs the tiered ~0.05
// ms/q — a 13x V8-tiering lottery, not a WASM regression). 200 untimed calls
// before timing reliably tiers the path; the measured number then reflects
// the steady-state optimized code, matching the JS baseline (which V8 tiers
// aggressively for pure-JS `getClusters`). See the 08 ticket answer.
const FFI_QUERY_WARMUP = 200;

function timeGetClustersFFI(sc, bbox, zoom, batches = 100) {
  // Per-timer warmup: tier the FFI hot loop before timing (see constant above).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) sc.get_clusters(bbox, zoom);
  const { result: last, ms } = timeMs(() => {
    let l;
    for (let i = 0; i < batches; i++) l = sc.get_clusters(bbox, zoom);
    return l;
  });
  return { elapsed: ms, perQuery: ms / batches, lastCount: last ? last.count : 0 };
}

// Decode the first cluster id from the WASM `rows` buffer (tag===1.0 at
// base+4, id at base+2). Mirrors the baseline's `pickClusterId` which reads
// `f.properties.cluster_id` — the WASM result is a typed array, not Features.
function pickClusterIdFFI(sc) {
  const top = sc.get_clusters(WORLD_BBOX, 0);
  const count = top.count | 0;
  const rows = top.rows;
  for (let i = 0; i < count; i++) {
    const base = i * ROW_STRIDE;
    if (rows[base + 4] === TAG_CLUSTER) return rows[base + 2];
  }
  return null;
}

function timeDrilldownFFI(sc, clusterId) {
  if (clusterId == null) return { children: null, leaves: null };
  const batches = 100;
  const id = clusterId >>> 0;

  // Per-timer warmup: tier the FFI hot loop before timing (see
  // FFI_QUERY_WARMUP). Drilldown queries return few results and run at
  // microsecond scale, so un-tiered measurements are pure noise.
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) sc.get_children(id);
  const { result: children, ms: childrenMs } = timeMs(() => {
    let c;
    for (let i = 0; i < batches; i++) c = sc.get_children(id);
    return c;
  });

  for (let i = 0; i < FFI_QUERY_WARMUP; i++) sc.get_leaves(id, 10, 0);
  const { result: leaves, ms: leavesMs } = timeMs(() => {
    let l;
    for (let i = 0; i < batches; i++) l = sc.get_leaves(id, 10, 0);
    return l;
  });

  return {
    children: {
      elapsed: childrenMs,
      perQuery: childrenMs / batches,
      count: children ? children.count : 0,
    },
    leaves: {
      elapsed: leavesMs,
      perQuery: leavesMs / batches,
      count: leaves ? leaves.count : 0,
    },
  };
}

// --- Worker-wired column --------------------------------------------------
//
// A thin main-thread wrapper around the `worker_threads` worker, mirroring
// `js/index.js`'s promise-correlation. The worker runs the real deployment
// worker logic (ported in `./worker-thread.js`) + the real `js/decode.js`
// runs here on the main thread for query decode — exactly as in deployment.

class WorkerWired {
  constructor() {
    this.#worker = new Worker(new URL('./worker-thread.js', import.meta.url));
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

  async load(points, options = {}, { transfer = true } = {}) {
    // Mirrors js/index.js (ticket 11): a Float64Array input is TRANSFERRED
    // into the worker by default (zero-copy; the source buffer detaches).
    // `transfer: false` posts without a transferList — the structured-clone
    // input path (the pre-ticket-11 tax), used by the clone-vs-transfer
    // before/after measurement below. GeoJSON input stays structured-cloned.
    if (points instanceof Float64Array) {
      const res = await this.#send('load', { points, options }, transfer ? [points.buffer] : []);
      if (!res.ok) throw new Error(res.error);
      this.#sourceFeatures = [];
      this.#specFieldNames = Array.isArray(options?.aggregation?.fields)
        ? options.aggregation.fields.map((f) => f.name)
        : [];
      return;
    }
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

  async getClusters(bbox, zoom) {
    const res = await this.#send('getClusters', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  // The hybrid id+encoded fast path (ticket 10). Mirrors `js/index.js`'s
  // `getClustersIds`: the worker returns { point_ids, cluster_rows,
  // cluster_aggregated, count, specLen }; the main thread hybrid-decodes it.
  // Point rows are zero-alloc source-feature reference pushes; Cluster rows
  // decode to synthesized Features. The returned Feature[] matches getClusters.
  async getClustersIds(bbox, zoom) {
    const res = await this.#send('getClustersIds', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return decodeHybridResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  async getChildren(clusterId) {
    const res = await this.#send('getChildren', { clusterId });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  async getLeaves(clusterId, limit = null, offset = 0) {
    const res = await this.#send('getLeaves', { clusterId, limit, offset });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  terminate() {
    this.#worker.terminate();
    this.#pending.clear();
  }

  #send(type, payload, transferList = []) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
  #sourceFeatures;
  #specFieldNames;
  #ready;
}

async function timeLoadWorker(points) {
  const sc = new WorkerWired();
  await sc.ready;
  // `load` is async (postMessage + structured clone of `points` into the
  // worker + the build). Time the whole await — this is what a consumer
  // pays. (Must use timeMsAsync, not sync timeMs, or we'd measure only the
  // postMessage dispatch, not the load completion.)
  const { ms } = await timeMsAsync(() => sc.load(points, OPTIONS));
  return { sc, elapsed: ms };
}

async function timeGetClustersWorker(sc, bbox, zoom, batches = 100) {
  // Per-timer warmup: tier the worker's WASM query hot loop before timing
  // (mirrors FFI_QUERY_WARMUP — the worker's get_clusters crosses the same
  // FFI boundary, and the decode tax is measured on the tiered path).
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await sc.getClusters(bbox, zoom);
  const { result: last, ms } = await timeMsAsync(() => {
    let l;
    return (async () => {
      for (let i = 0; i < batches; i++) l = await sc.getClusters(bbox, zoom);
      return l;
    })();
  });
  return { elapsed: ms, perQuery: ms / batches, lastCount: last ? last.length : 0 };
}

// Time the hybrid id+encoded fast path (ticket 10). Same warmup discipline as
// the encoded path — the worker's `get_clusters_ids` crosses the same FFI
// boundary, and the hybrid decode must sit on the tiered path. The count must
// equal the encoded path's count for the same bbox/zoom (same lattice, same
// kd-tree `range` call — membership, not output format, is what is compared).
async function timeGetClustersIdsWorker(sc, bbox, zoom, batches = 100) {
  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await sc.getClustersIds(bbox, zoom);
  const { result: last, ms } = await timeMsAsync(() => {
    let l;
    return (async () => {
      for (let i = 0; i < batches; i++) l = await sc.getClustersIds(bbox, zoom);
      return l;
    })();
  });
  return { elapsed: ms, perQuery: ms / batches, lastCount: last ? last.length : 0 };
}

async function pickClusterIdWorker(sc) {
  const top = await sc.getClusters(WORLD_BBOX, 0);
  for (const f of top) {
    if (f.properties && f.properties.cluster) return f.properties.cluster_id;
  }
  return null;
}

async function timeDrilldownWorker(sc, clusterId) {
  if (clusterId == null) return { children: null, leaves: null };
  const batches = 100;

  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await sc.getChildren(clusterId);
  const { ms: childrenMs } = await timeMsAsync(() => {
    let c;
    return (async () => {
      for (let i = 0; i < batches; i++) c = await sc.getChildren(clusterId);
      return c;
    })();
  });

  for (let i = 0; i < FFI_QUERY_WARMUP; i++) await sc.getLeaves(clusterId, 10, 0);
  const { ms: leavesMs } = await timeMsAsync(() => {
    let l;
    return (async () => {
      for (let i = 0; i < batches; i++) l = await sc.getLeaves(clusterId, 10, 0);
      return l;
    })();
  });

  return {
    children: { elapsed: childrenMs, perQuery: childrenMs / batches, count: null },
    leaves: { elapsed: leavesMs, perQuery: leavesMs / batches, count: null },
  };
}

// --- shared helpers -------------------------------------------------------

// Time an async function with nanosecond resolution (worker calls are async).
async function timeMsAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

// Median of 3 numeric samples (ms). Reduces single-run noise; matches the
// baseline's per-batch structure but adds reproducibility for the ratio gate.
function medianOf3(a, b, c) {
  const arr = [a, b, c].sort((x, y) => x - y);
  return arr[1];
}

// --- per-dataset runners --------------------------------------------------

function runFFI(name, points) {
  console.log(`\n=== ${name} (${points.length.toLocaleString()} points) — FFI-direct ===`);
  // Warmup: one untimed load+query pass to fill caches / JIT the hot path.
  // `free()` the instance explicitly — Node's FinalizationRegistry isn't
  // prompt enough between back-to-back large loads at 6M, so un-finalized
  // indices pile up in WASM linear memory until `__wbindgen_malloc` traps
  // (`unreachable`). Explicit `free()` reclaims the index/lattice/coords
  // immediately. (See the 08 ticket answer for the full finding.)
  {
    const sc = new SuperclusterWasm();
    sc.load(points, OPTIONS);
    sc.get_clusters(SMALL_BBOX, 6);
    sc.get_clusters(WORLD_BBOX, 0);
    sc.free();
  }
  const flat = flattenCoords(points);
  const loadSamples = [];
  const loadCoordsSamples = [];
  let sc;
  for (let r = 0; r < 3; r++) {
    // Free the previous iteration's index before building the next, so the
    // median-of-3 loop doesn't accumulate 3 live 6M indices in WASM memory.
    if (sc) sc.free();
    const { sc: s, elapsed } = timeLoadFFI(points);
    sc = s;
    loadSamples.push(elapsed);
  }
  // Measure the fast path on a separate instance cycle so the GeoJSON-path
  // index is freed first (same memory-reclamation discipline).
  let scCoords;
  for (let r = 0; r < 3; r++) {
    if (scCoords) scCoords.free();
    const { sc: s, elapsed } = timeLoadCoordsFFI(flat);
    scCoords = s;
    loadCoordsSamples.push(elapsed);
  }
  const loadMs = medianOf3(...loadSamples);
  const loadCoordsMs = medianOf3(...loadCoordsSamples);
  console.log(`  load:            ${loadMs.toFixed(0)} ms (median of 3)`);
  console.log(`  load_coords:     ${loadCoordsMs.toFixed(0)} ms (median of 3, fast path)`);

  // Query timings use the GeoJSON-path index (the deployment-default `load`).
  const small = timeGetClustersFFI(sc, SMALL_BBOX, 6);
  console.log(`  getClusters small bbox x100: ${small.elapsed.toFixed(2)} ms (${small.perQuery.toFixed(3)} ms/query, ${small.lastCount} results)`);

  const world = timeGetClustersFFI(sc, WORLD_BBOX, 0);
  console.log(`  getClusters world    x100: ${world.elapsed.toFixed(2)} ms (${world.perQuery.toFixed(3)} ms/query, ${world.lastCount} results)`);

  const clusterId = pickClusterIdFFI(sc);
  const drill = timeDrilldownFFI(sc, clusterId);
  if (drill.children) {
    console.log(`  getChildren x100:         ${drill.children.elapsed.toFixed(2)} ms (${drill.children.perQuery.toFixed(3)} ms/query, ${drill.children.count} children)`);
    console.log(`  getLeaves   x100:         ${drill.leaves.elapsed.toFixed(2)} ms (${drill.leaves.perQuery.toFixed(3)} ms/query, ${drill.leaves.count} leaves)`);
  } else {
    console.log(`  (no top-level cluster to drill into)`);
  }
  // Free both indices — keeps WASM memory flat across datasets/sizes.
  sc.free();
  scCoords.free();
  return { name, count: points.length, loadMs, loadCoordsMs, small, world, drill };
}

async function runWorker(name, points) {
  console.log(`\n=== ${name} (${points.length.toLocaleString()} points) — worker-wired ===`);
  // Warmup: one untimed load+query pass.
  {
    const sc = new WorkerWired();
    await sc.ready;
    await sc.load(points, OPTIONS);
    await sc.getClusters(SMALL_BBOX, 6);
    await sc.getClusters(WORLD_BBOX, 0);
    sc.terminate();
  }
  const loadSamples = [];
  let sc;
  for (let r = 0; r < 3; r++) {
    // Terminate the previous worker before spawning the next, so the
    // median-of-3 loop doesn't leak 3 live worker threads + their WASM
    // memory (each holds a 6M index). `terminate()` kills the worker
    // thread and releases all its WASM linear memory immediately.
    if (sc) sc.terminate();
    const { sc: s, elapsed } = await timeLoadWorker(points);
    sc = s;
    loadSamples.push(elapsed);
  }
  const loadMs = medianOf3(...loadSamples);
  console.log(`  load:            ${loadMs.toFixed(0)} ms (median of 3)`);

  // load_coords input-boundary before/after (ticket 11): the same flat
  // coordinate array loaded into a fresh worker per iteration, once
  // structured-cloned (the pre-ticket-11 input tax — `transfer: false`) and
  // once transferred (zero-copy, the deployment default). Fresh worker per
  // iteration — back-to-back large loads in one worker pile up WASM linear
  // memory and trap (the 08 finding), and a fresh worker per load mirrors
  // the deployment pattern (one index per worker lifetime). The flatten and
  // the per-run `new Float64Array(flat)` copy are both outside timing (a
  // real caller builds the array once), so the measured delta is purely the
  // postMessage input crossing (clone vs transfer). CAVEAT: at 6M the build
  // itself (~2-4 s) has run-to-run variance that swamps the ~50-100 ms clone
  // tax — the isolated echo measurement (bench/attribution) is the
  // trustworthy signal for this layer; these round-trip medians are reported
  // for completeness.
  const flat = flattenCoords(points);
  const loadCoordsCloneSamples = [];
  const loadCoordsTransferSamples = [];
  for (let r = 0; r < 3; r++) {
    let scCoords = new WorkerWired();
    await scCoords.ready;
    let copy = new Float64Array(flat);
    const { ms: cloneMs } = await timeMsAsync(() => scCoords.load(copy, OPTIONS, { transfer: false }));
    loadCoordsCloneSamples.push(cloneMs);
    scCoords.terminate();

    scCoords = new WorkerWired();
    await scCoords.ready;
    copy = new Float64Array(flat);
    const { ms: transferMs } = await timeMsAsync(() => scCoords.load(copy, OPTIONS));
    loadCoordsTransferSamples.push(transferMs);
    scCoords.terminate();
  }
  const loadCoordsCloneMs = medianOf3(...loadCoordsCloneSamples);
  const loadCoordsMs = medianOf3(...loadCoordsTransferSamples);
  console.log(`  load_coords:     ${loadCoordsMs.toFixed(0)} ms (median of 3, transferred input)`);
  console.log(`  load_coords clone-input: ${loadCoordsCloneMs.toFixed(0)} ms (median of 3, pre-ticket-11 input tax)`);

  const small = await timeGetClustersWorker(sc, SMALL_BBOX, 6);
  console.log(`  getClusters small bbox x100: ${small.elapsed.toFixed(2)} ms (${small.perQuery.toFixed(3)} ms/query, ${small.lastCount} results)`);

  const world = await timeGetClustersWorker(sc, WORLD_BBOX, 0);
  console.log(`  getClusters world    x100: ${world.elapsed.toFixed(2)} ms (${world.perQuery.toFixed(3)} ms/query, ${world.lastCount} results)`);

  // Hybrid id+encoded fast path (ticket 10). Same lattice, same kd-tree
  // `range` membership as the encoded path — the count must match exactly.
  // This is the bench count-parity gate for `getClustersIds`: a divergence
  // would mean the hybrid path drops or duplicates rows relative to the
  // encoded path, breaking the drop-in contract.
  const idsSmall = await timeGetClustersIdsWorker(sc, SMALL_BBOX, 6);
  const idsWorld = await timeGetClustersIdsWorker(sc, WORLD_BBOX, 0);
  console.log(`  getClustersIds small x100: ${idsSmall.elapsed.toFixed(2)} ms (${idsSmall.perQuery.toFixed(3)} ms/query, ${idsSmall.lastCount} results)`);
  console.log(`  getClustersIds world x100: ${idsWorld.elapsed.toFixed(2)} ms (${idsWorld.perQuery.toFixed(3)} ms/query, ${idsWorld.lastCount} results)`);
  if (idsSmall.lastCount !== small.lastCount) {
    throw new Error(`getClustersIds small count ${idsSmall.lastCount} != getClusters ${small.lastCount} (parity gate)`);
  }
  if (idsWorld.lastCount !== world.lastCount) {
    throw new Error(`getClustersIds world count ${idsWorld.lastCount} != getClusters ${world.lastCount} (parity gate)`);
  }

  const clusterId = await pickClusterIdWorker(sc);
  const drill = await timeDrilldownWorker(sc, clusterId);
  if (drill.children) {
    console.log(`  getChildren x100:         ${drill.children.elapsed.toFixed(2)} ms (${drill.children.perQuery.toFixed(3)} ms/query)`);
    console.log(`  getLeaves   x100:         ${drill.leaves.elapsed.toFixed(2)} ms (${drill.leaves.perQuery.toFixed(3)} ms/query)`);
  } else {
    console.log(`  (no top-level cluster to drill into)`);
  }
  sc.terminate();
  return { name, count: points.length, loadMs, loadCoordsMs, loadCoordsCloneMs, small, world, idsSmall, idsWorld, drill };
}

function summarizeFFI(results) {
  const summary = results.map((r) => ({
    dataset: r.name,
    n: r.count,
    load_ms: Number(r.loadMs.toFixed(0)),
    load_coords_ms: Number(r.loadCoordsMs.toFixed(0)),
    getClusters_small_ms_per_query: Number(r.small.perQuery.toFixed(3)),
    getClusters_world_ms_per_query: Number(r.world.perQuery.toFixed(3)),
    getChildren_ms_per_query: r.drill.children ? Number(r.drill.children.perQuery.toFixed(3)) : null,
    getLeaves_ms_per_query: r.drill.leaves ? Number(r.drill.leaves.perQuery.toFixed(3)) : null,
    getClusters_small_count: r.small.lastCount,
    getClusters_world_count: r.world.lastCount,
  }));
  console.error('\nWASM_SUMMARY_JSON=' + JSON.stringify(summary));

  const perQueryKinds = ['getClusters_small', 'getClusters_world', 'getChildren', 'getLeaves'];
  const geoMeans = {};
  for (const kind of perQueryKinds) {
    const samples = results
      .map((r) => {
        if (kind === 'getClusters_small') return r.small.perQuery;
        if (kind === 'getClusters_world') return r.world.perQuery;
        if (kind === 'getChildren') return r.drill.children?.perQuery;
        if (kind === 'getLeaves') return r.drill.leaves?.perQuery;
        return null;
      })
      .filter((v) => v != null && v > 0);
    geoMeans[kind] = geometricMean(samples);
  }
  // Load geomeans: both the GeoJSON `load` path and the `load_coords` fast
  // path, so the orchestrator can report both ratios vs the JS baseline.
  geoMeans.load = geometricMean(results.map((r) => r.loadMs));
  geoMeans.load_coords = geometricMean(results.map((r) => r.loadCoordsMs));
  console.error('WASM_GEOMEAN_MS_PER_QUERY=' + JSON.stringify(geoMeans, null, 0));
  return { summary, geoMeans };
}

function summarizeWorker(results) {
  const summary = results.map((r) => ({
    dataset: r.name,
    n: r.count,
    load_ms: Number(r.loadMs.toFixed(0)),
    load_coords_ms: Number(r.loadCoordsMs.toFixed(0)),
    load_coords_clone_ms: Number(r.loadCoordsCloneMs.toFixed(0)),
    getClusters_small_ms_per_query: Number(r.small.perQuery.toFixed(3)),
    getClusters_world_ms_per_query: Number(r.world.perQuery.toFixed(3)),
    getClustersIds_small_ms_per_query: Number(r.idsSmall.perQuery.toFixed(3)),
    getClustersIds_world_ms_per_query: Number(r.idsWorld.perQuery.toFixed(3)),
    getChildren_ms_per_query: r.drill.children ? Number(r.drill.children.perQuery.toFixed(3)) : null,
    getLeaves_ms_per_query: r.drill.leaves ? Number(r.drill.leaves.perQuery.toFixed(3)) : null,
    getClusters_small_count: r.small.lastCount,
    getClusters_world_count: r.world.lastCount,
    getClustersIds_small_count: r.idsSmall.lastCount,
    getClustersIds_world_count: r.idsWorld.lastCount,
  }));
  console.error('\nWORKER_SUMMARY_JSON=' + JSON.stringify(summary));

  const perQueryKinds = ['getClusters_small', 'getClusters_world', 'getClustersIds_small', 'getClustersIds_world', 'getChildren', 'getLeaves'];
  const geoMeans = {};
  for (const kind of perQueryKinds) {
    const samples = results
      .map((r) => {
        if (kind === 'getClusters_small') return r.small.perQuery;
        if (kind === 'getClusters_world') return r.world.perQuery;
        if (kind === 'getClustersIds_small') return r.idsSmall.perQuery;
        if (kind === 'getClustersIds_world') return r.idsWorld.perQuery;
        if (kind === 'getChildren') return r.drill.children?.perQuery;
        if (kind === 'getLeaves') return r.drill.leaves?.perQuery;
        return null;
      })
      .filter((v) => v != null && v > 0);
    geoMeans[kind] = geometricMean(samples);
  }
  // Load geomeans: the GeoJSON `load` path (structured-clone input — the
  // before), the `load_coords` fast path (transferred input — the ticket-11
  // after), and the clone-input `load_coords` variant (the before for the
  // input-boundary before/after), so the orchestrator can report all three.
  geoMeans.load = geometricMean(results.map((r) => r.loadMs));
  geoMeans.load_coords = geometricMean(results.map((r) => r.loadCoordsMs));
  geoMeans.load_coords_clone = geometricMean(results.map((r) => r.loadCoordsCloneMs));
  console.error('WORKER_GEOMEAN_MS_PER_QUERY=' + JSON.stringify(geoMeans, null, 0));
  return { summary, geoMeans };
}

// --- main -----------------------------------------------------------------

async function main() {
  console.log('supercluster-wasm — WASM harness (FFI-direct + worker-wired)');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}`);

  const centers = loadCenters();

  const ffiResults = [];
  const workerResults = [];

  for (const n of SIZES) {
    const uniform = uniformRandom(n, 1234);
    ffiResults.push(runFFI('uniform-random', uniform));

    const clustered = clusteredSynthetic(n, 1234, centers);
    ffiResults.push(runFFI('clustered-synthetic', clustered));
  }

  for (const n of SIZES) {
    const uniform = uniformRandom(n, 1234);
    workerResults.push(await runWorker('uniform-random', uniform));

    const clustered = clusteredSynthetic(n, 1234, centers);
    workerResults.push(await runWorker('clustered-synthetic', clustered));
  }

  summarizeFFI(ffiResults);
  summarizeWorker(workerResults);
}

await main();
// Force exit: the worker_threads `parentPort.on('message')` listener keeps
// the worker thread alive after `terminate()`, and Node's event loop won't
// drain it promptly. The harness has emitted all its output; exit cleanly.
process.exit(0);
