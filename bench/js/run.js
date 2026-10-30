// js-worker harness (ticket 12): the JS supercluster baseline wired into a
// worker_threads worker — the fourth column of the comparison matrix.
//
// Until now the worker-wired column compared "WASM behind IPC" against "JS
// direct on the main thread" — an asymmetric comparison that conflates the
// worker tax with the implementation difference. This harness completes the
// matrix: the same JS implementation, behind the same kind of worker
// boundary, so the compare orchestrator can report deployment shape vs
// deployment shape (wasm-worker vs js-worker).
//
// Mirrors `bench/wasm/run.js`'s worker-wired column so the two are directly
// comparable:
//   - FFI_QUERY_WARMUP=200 untimed calls before each query timer (V8 tiers
//     the postMessage hot path the same way it tiers the FFI hot loop).
//   - Fresh worker per load iteration (the WASM harness terminates + respawns
//     to keep WASM linear memory flat; here it keeps the discipline identical
//     — one index per worker lifetime, the deployment pattern).
//   - median-of-3 per metric; queries keep the 100-batch structure.
//
// Timing conventions (ticket 12 decisions): the `load` timing INCLUDES the
// main-thread structured-clone of the GeoJSON feature array into the worker
// (it happens inside postMessage, within the timed region — that IS the
// js-worker input tax); dataset generation sits outside the timed region
// (mirrors the WASM harness's out-of-region flatten). Query results come
// back as GeoJSON Feature arrays posted as-is — the object-graph clone on
// the way back is the js-worker return tax, measured as-is.
//
// Output: plain text to stdout, plus `JS_WORKER_SUMMARY_JSON=` /
// `JS_WORKER_GEOMEAN_MS_PER_QUERY=` on stderr for the compare orchestrator.
// Run with: pnpm bench:js  (SMALL=1 for a 10k smoke pass)

import { Worker } from 'node:worker_threads';
import { uniformRandom, clusteredSynthetic, loadCenters } from '../datasets/generate.js';
import { parseSizes, geometricMean } from '../util.js';
import { DEFAULT_OPTIONS } from '../oracle/config.js';

const SIZES = parseSizes(process.env.SMALL ? [10_000] : [1_000_000, 6_000_000]);

const OPTIONS = DEFAULT_OPTIONS; // matches refs/supercluster/bench.js (maxZoom 6)

// A small bbox centered on a populated region (US east coast) and the
// whole-world bbox, to exercise both selective and full-scan query paths.
const SMALL_BBOX = [-90, 25, -70, 45];
const WORLD_BBOX = [-180, -90, 180, 90];

// Warmup call count for the query timers — mirrors the WASM harness's
// FFI_QUERY_WARMUP (V8 tiers the postMessage hot path the same way).
const QUERY_WARMUP = 200;

// A thin main-thread wrapper around the js worker, mirroring the
// promise-correlation shape of `bench/wasm/run.js`'s WorkerWired.
class JsWorker {
  constructor() {
    this.#worker = new Worker(new URL('./worker.js', import.meta.url));
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

  // Load GeoJSON features + options. The structured-clone of `points` into
  // the worker happens inside postMessage — within the timed region (the
  // js-worker input tax, measured as-is per the ticket-12 convention).
  async load(points, options = {}) {
    const res = await this.#send('load', { points, options });
    if (!res.ok) throw new Error(res.error);
  }

  async getClusters(bbox, zoom) {
    const res = await this.#send('getClusters', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return res.features;
  }

  async getChildren(clusterId) {
    const res = await this.#send('getChildren', { clusterId });
    if (res.ok === false) throw new Error(res.error);
    return res.features;
  }

  async getLeaves(clusterId, limit = null, offset = 0) {
    const res = await this.#send('getLeaves', { clusterId, limit, offset });
    if (res.ok === false) throw new Error(res.error);
    return res.features;
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
  #ready;
}

// Time an async function with nanosecond resolution (worker calls are async).
async function timeMsAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

// Median of 3 numeric samples (ms). Matches the other runners' discipline.
function medianOf3(a, b, c) {
  const arr = [a, b, c].sort((x, y) => x - y);
  return arr[1];
}

async function timeLoadWorker(points) {
  const sc = new JsWorker();
  await sc.ready;
  const { ms } = await timeMsAsync(() => sc.load(points, OPTIONS));
  return { sc, elapsed: ms };
}

async function timeGetClustersWorker(sc, bbox, zoom, batches = 100) {
  for (let i = 0; i < QUERY_WARMUP; i++) await sc.getClusters(bbox, zoom);
  const { result: last, ms } = await timeMsAsync(() => {
    let l;
    return (async () => {
      for (let i = 0; i < batches; i++) l = await sc.getClusters(bbox, zoom);
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

  for (let i = 0; i < QUERY_WARMUP; i++) await sc.getChildren(clusterId);
  const { ms: childrenMs } = await timeMsAsync(() => {
    let c;
    return (async () => {
      for (let i = 0; i < batches; i++) c = await sc.getChildren(clusterId);
      return c;
    })();
  });

  for (let i = 0; i < QUERY_WARMUP; i++) await sc.getLeaves(clusterId, 10, 0);
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

async function runWorker(name, points) {
  console.log(`\n=== ${name} (${points.length.toLocaleString()} points) — js-worker ===`);
  // Warmup: one untimed load+query pass.
  {
    const sc = new JsWorker();
    await sc.ready;
    await sc.load(points, OPTIONS);
    await sc.getClusters(SMALL_BBOX, 6);
    await sc.getClusters(WORLD_BBOX, 0);
    sc.terminate();
  }
  const loadSamples = [];
  let sc;
  for (let r = 0; r < 3; r++) {
    // Fresh worker per iteration — the same discipline as the WASM harness
    // (one index per worker lifetime, the deployment pattern).
    if (sc) sc.terminate();
    const { sc: s, elapsed } = await timeLoadWorker(points);
    sc = s;
    loadSamples.push(elapsed);
  }
  const loadMs = medianOf3(...loadSamples);
  console.log(`  load:            ${loadMs.toFixed(0)} ms (median of 3)`);

  const small = await timeGetClustersWorker(sc, SMALL_BBOX, 6);
  console.log(`  getClusters small bbox x100: ${small.elapsed.toFixed(2)} ms (${small.perQuery.toFixed(3)} ms/query, ${small.lastCount} results)`);

  const world = await timeGetClustersWorker(sc, WORLD_BBOX, 0);
  console.log(`  getClusters world    x100: ${world.elapsed.toFixed(2)} ms (${world.perQuery.toFixed(3)} ms/query, ${world.lastCount} results)`);

  const clusterId = await pickClusterIdWorker(sc);
  const drill = await timeDrilldownWorker(sc, clusterId);
  if (drill.children) {
    console.log(`  getChildren x100:         ${drill.children.elapsed.toFixed(2)} ms (${drill.children.perQuery.toFixed(3)} ms/query)`);
    console.log(`  getLeaves   x100:         ${drill.leaves.elapsed.toFixed(2)} ms (${drill.leaves.perQuery.toFixed(3)} ms/query)`);
  } else {
    console.log(`  (no top-level cluster to drill into)`);
  }
  sc.terminate();
  return { name, count: points.length, loadMs, small, world, drill };
}

function summarize(results) {
  const summary = results.map((r) => ({
    dataset: r.name,
    n: r.count,
    load_ms: Number(r.loadMs.toFixed(0)),
    getClusters_small_ms_per_query: Number(r.small.perQuery.toFixed(3)),
    getClusters_world_ms_per_query: Number(r.world.perQuery.toFixed(3)),
    getChildren_ms_per_query: r.drill.children ? Number(r.drill.children.perQuery.toFixed(3)) : null,
    getLeaves_ms_per_query: r.drill.leaves ? Number(r.drill.leaves.perQuery.toFixed(3)) : null,
    getClusters_small_count: r.small.lastCount,
    getClusters_world_count: r.world.lastCount,
  }));
  console.error('\nJS_WORKER_SUMMARY_JSON=' + JSON.stringify(summary));

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
  geoMeans.load = geometricMean(results.map((r) => r.loadMs));
  console.error('JS_WORKER_GEOMEAN_MS_PER_QUERY=' + JSON.stringify(geoMeans, null, 0));
  return { summary, geoMeans };
}

async function main() {
  console.log('supercluster-wasm — js-worker harness (JS supercluster behind a worker)');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}`);

  const centers = loadCenters();
  const results = [];

  for (const n of SIZES) {
    const uniform = uniformRandom(n, 1234);
    results.push(await runWorker('uniform-random', uniform));

    const clustered = clusteredSynthetic(n, 1234, centers);
    results.push(await runWorker('clustered-synthetic', clustered));
  }

  summarize(results);
}

await main();
// Force exit: the worker_threads `parentPort.on('message')` listener keeps
// the worker thread alive after `terminate()`, and Node's event loop won't
// drain it promptly. The harness has emitted all its output; exit cleanly.
process.exit(0);
