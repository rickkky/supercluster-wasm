// Compare-page engines (ticket 13 follow-up): deployment shapes behind
// one async interface, so the split-screen page can swap the right map's
// engine without caring about the implementation.
//
//   wasm-worker — the production chain (js/index.js -> js/worker.js ->
//                 pkg/supercluster.wasm) on the load_coords fast path: the
//                 input is a transferred Float64Array (zero-copy, no GeoJSON
//                 parse in Rust); the LEFT map's fixed engine.
//   wasm-worker-geojson — the same production chain on the GeoJSON input
//                 path (structured clone into the worker + per-feature parse
//                 in Rust — the measured load bottleneck, ticket 08).
//   wasm        — SuperclusterWasm directly on the main thread (no worker;
//                 the FFI + build cost lands on the UI thread).
//   js          — the reference `supercluster` npm package on the main
//                 thread.
//   js-worker   — the reference package behind a browser module worker
//                 (demo/js-worker.browser.js); the structured clone of the
//                 GeoJSON input into the worker is the input tax, the
//                 object-graph clone of the result back is the return tax.
//
// Every engine exposes the same async surface:
//   ready            — promise resolving when the engine can accept load()
//   load(features, options) — the engine's input shape in (coords
//                      Float64Array for wasm-worker, GeoJSON Feature[]
//                      otherwise), timed by the caller
//   getClusters(bbox, zoom) — GeoJSON Feature[] out
//   terminate()      — release the worker/index
//
// Timing conventions: `load` INCLUDES each engine's input tax (the
// structured clone into the js-worker, the FFI conversion into wasm) — it
// happens inside the caller's timed region. Query results are decoded
// GeoJSON Features in all cases, so the renderer stays engine-agnostic.

import { Supercluster } from '../js/index.js';
import { decodeQueryResult } from '../js/decode.js';

// --- wasm-worker: the production wrapper, as-is ----------------------------

export class WasmWorkerEngine {
  constructor() {
    this.sc = new Supercluster();
    this.ready = this.sc.ready;
  }
  async load(points, options) {
    // Await worker boot before posting: a load posted before the worker's
    // WASM init resolves races its `self.onmessage` assignment (observed as
    // a silently dropped request in Chrome).
    await this.ready;
    await this.sc.load(points, options);
  }
  async getClusters(bbox, zoom) {
    return this.sc.getClusters(bbox, zoom);
  }
  terminate() {
    this.sc.terminate();
  }
}

// --- wasm-worker-geojson: the production chain on the GeoJSON input path ---

export class WasmWorkerGeojsonEngine {
  constructor() {
    this.sc = new Supercluster();
    this.ready = this.sc.ready;
  }
  async load(features, options) {
    // Same ready-await as WasmWorkerEngine (worker boot race).
    await this.ready;
    await this.sc.load(features, options);
  }
  async getClusters(bbox, zoom) {
    return this.sc.getClusters(bbox, zoom);
  }
  terminate() {
    this.sc.terminate();
  }
}

// --- wasm: SuperclusterWasm directly on the main thread --------------------

export class WasmMainThreadEngine {
  constructor() {
    this.ready = import('../pkg/supercluster.js').then((mod) => {
      this.mod = mod;
      return mod.default();
    });
  }
  async load(features, options) {
    await this.ready;
    this.index = new this.mod.SuperclusterWasm();
    this.index.load(features, options);
    // feature_id indexes the geometry-bearing subset (query.rs
    // FeatureKind::Point) — same normalization js/index.js does.
    this.sourceFeatures = features.filter((f) => f && f.geometry);
    this.specFieldNames = Array.isArray(options?.aggregation?.fields)
      ? options.aggregation.fields.map((f) => f.name)
      : [];
  }
  async getClusters(bbox, zoom) {
    const res = this.index.get_clusters(bbox, zoom);
    // Copy the WASM-memory views into owned arrays before decoding — the
    // views are only valid until the next call into the instance.
    return decodeQueryResult(
      {
        count: res.count,
        rows: new Float64Array(res.rows),
        aggregated: new Float64Array(res.aggregated),
        specLen: res.specLen,
      },
      this.sourceFeatures,
      this.specFieldNames,
    );
  }
  terminate() {
    this.index = null;
  }
}

// --- js: the reference supercluster package on the main thread -------------

// Translate the demo's Aggregation Spec into the npm package's native
// map/reduce aggregation options, so the JS engines' cluster properties
// match the WASM side's (totalValue on every cluster — the compare page's
// labels then render identically). The callbacks' cost is part of the JS
// engines' load time, which is the honest comparison.
function specToMapReduce(options) {
  const fields = Array.isArray(options?.aggregation?.fields) ? options.aggregation.fields : [];
  const opts = { ...options };
  delete opts.aggregation;
  if (fields.length) {
    // One map pass per field would be wasteful; a single map emitting every
    // field's prop, and a reduce summing each, covers the spec's shape.
    opts.map = (props) => {
      const acc = {};
      for (const f of fields) acc[f.name] = props[f.prop];
      return acc;
    };
    opts.reduce = (acc, props) => {
      for (const f of fields) acc[f.name] = (acc[f.name] || 0) + props[f.name];
      return acc;
    };
  }
  return opts;
}

export class JsMainThreadEngine {
  constructor() {
    this.ready = import('supercluster').then((mod) => {
      const SC = typeof mod.default === 'function' ? mod.default : mod.default.default;
      this.SC = SC;
    });
  }
  async load(features, options) {
    await this.ready;
    this.index = new this.SC({ ...specToMapReduce(options), log: false });
    this.index.load(features);
  }
  async getClusters(bbox, zoom) {
    return this.index.getClusters(bbox, zoom);
  }
  terminate() {
    this.index = null;
  }
}

// --- js-worker: the reference package behind a browser module worker -------

export class JsWorkerEngine {
  constructor() {
    this.worker = new Worker(new URL('./js-worker.browser.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      const onReady = (e) => {
        if (e.data && e.data.type === 'ready') {
          this.worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.worker.addEventListener('message', onReady);
      this.worker.addEventListener('error', (err) => reject(err), { once: true });
    });
    this.worker.addEventListener('message', (e) => this.#onmessage(e.data));
  }
  async load(features, options) {
    await this.ready;
    const res = await this.#send('load', { points: features, options });
    if (!res.ok) throw new Error(res.error);
  }
  async getClusters(bbox, zoom) {
    const res = await this.#send('getClusters', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return res.features;
  }
  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
  #send(type, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  #onmessage(msg) {
    if (!msg || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    p.resolve(msg);
  }
}

export const ENGINES = {
  'wasm-worker': WasmWorkerEngine,
  'wasm-worker-geojson': WasmWorkerGeojsonEngine,
  wasm: WasmMainThreadEngine,
  js: JsMainThreadEngine,
  'js-worker': JsWorkerEngine,
};
