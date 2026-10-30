// Tier 4 (ticket 07): the main-thread async wrapper around the WASM worker.
//
// `Supercluster` owns a single Web Worker (`js/worker.js`, an ESM module
// worker) and exposes the clustering API as async methods. Each call is
// promise-correlated by an incrementing `id`; the worker's response resolves
// the matching promise. Query results are decoded from the compact typed-array
// contract into GeoJSON Features via `decodeQueryResult`.
//
// The Spatial Index stays opaque in WASM linear memory (ADR 0002): only result
// data crosses the worker boundary, as transferable Float64Arrays.

import { decodeQueryResult, decodeHybridResult } from './decode.js';

export class Supercluster {
  constructor() {
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.#pending = new Map();
    this.#nextId = 1;
    this.#sourceFeatures = [];
    this.#specFieldNames = [];
    this.#ready = new Promise((resolve, reject) => {
      const onReady = (e) => {
        if (e.data && e.data.type === 'ready') {
          this.#worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.#worker.addEventListener('message', onReady);
      this.#worker.addEventListener('error', (err) => reject(err), { once: true });
    });
    this.#worker.addEventListener('message', (e) => this.#onmessage(e.data));
  }

  // Wait for the worker to finish booting (wasm init + 'ready').
  get ready() {
    return this.#ready;
  }

  // Load GeoJSON features + options into the index. Returns a promise that
  // resolves on success or rejects with the worker's error string.
  //
  // A pre-flattened `Float64Array` of `[lng, lat, ...]` takes the fast path:
  // the worker routes it to `load_coords` (one copy + pure-Rust build, no
  // GeoJSON parse — the measured load bottleneck), and the coordinate buffer
  // is TRANSFERRED into the worker (zero-copy — the structured-clone copy of
  // a 96 MB coordinate array costs 87-151 ms per load at 6M; the transfer
  // eliminates it, ticket 09 attribution / ticket 11). Transfer detaches the
  // buffer: the caller's Float64Array is consumed and unusable from the
  // moment `load()` is called — including if `load()` later rejects — pass a
  // copy if the array must stay re-usable. A flat array carries no source
  // features, so point decode falls back to synthesized coordinates
  // (decode.js's defensive branch); callers using the fast path typically
  // render only clusters, not unclustered points.
  async load(points, options = {}) {
    // The Float64Array fast path transfers the buffer into the worker
    // (zero-copy); GeoJSON input stays structured-cloned.
    const transferList = points instanceof Float64Array ? [points.buffer] : [];
    const res = await this.#send('load', { points, options }, transferList);
    if (!res.ok) throw new Error(res.error);
    if (points instanceof Float64Array) {
      this.#sourceFeatures = [];
      this.#specFieldNames = Array.isArray(options?.aggregation?.fields)
        ? options.aggregation.fields.map((f) => f.name)
        : [];
      return;
    }
    // Normalize to the feature array: accept either a bare Feature[] or a
    // FeatureCollection { features: [...] } (the GeoJSONInput union). The
    // main thread keeps the geometry-bearing subset for point rendering and
    // decode: feature_id indexes this subset (query.rs FeatureKind::Point).
    const feats = Array.isArray(points) ? points : Array.isArray(points?.features) ? points.features : [];
    this.#sourceFeatures = feats.filter((f) => f && f.geometry);
    this.#specFieldNames = Array.isArray(options?.aggregation?.fields)
      ? options.aggregation.fields.map((f) => f.name)
      : [];
  }

  // Viewport query. `bbox` is [minLng, minLat, maxLng, maxLat]. Returns
  // decoded GeoJSON Features.
  async getClusters(bbox, zoom) {
    const res = await this.#send('getClusters', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  // Viewport query, the hybrid id+encoded fast path (ticket 10). `bbox` is
  // [minLng, minLat, maxLng, maxLat]. Returns decoded GeoJSON Features whose
  // shape matches `getClusters` exactly — a drop-in replacement.
  //
  // Point rows are `sourceFeatures[point_id]` reference pushes (zero
  // allocation — the main thread indexes its own already-held source features);
  // Cluster rows decode to Feature objects (the few, unavoidable allocations —
  // Clusters are synthesized inside WASM with no source feature on the main
  // thread). This bypasses the per-Point typed-array encode that dominates
  // Point-dense viewports. Requires the main thread to hold the source features
  // (i.e. loaded via GeoJSON, not `load_coords`); when no source features are
  // held, point rows fall back to null-geometry Features — prefer `getClusters`
  // for that case.
  async getClustersIds(bbox, zoom) {
    const res = await this.#send('getClustersIds', { bbox, zoom });
    if (res.ok === false) throw new Error(res.error);
    return decodeHybridResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  // Direct children of a cluster, in kd-tree traversal order.
  async getChildren(clusterId) {
    const res = await this.#send('getChildren', { clusterId });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  // Paginated leaves. `limit` is a number for a finite page or null/undefined
  // for all leaves.
  async getLeaves(clusterId, limit = null, offset = 0) {
    const res = await this.#send('getLeaves', { clusterId, limit, offset });
    if (res.ok === false) throw new Error(res.error);
    return decodeQueryResult(res, this.#sourceFeatures, this.#specFieldNames);
  }

  // The lowest zoom at which the cluster expands into >1 child.
  async getClusterExpansionZoom(clusterId) {
    const res = await this.#send('getClusterExpansionZoom', { clusterId });
    if (res.ok === false) throw new Error(res.error);
    return res.zoom;
  }

  // Terminate the worker. No further calls are possible after this.
  terminate() {
    this.#worker.terminate();
    this.#pending.clear();
  }

  // --- internals ---

  // Send a request and return a promise resolved by the worker's response
  // (correlated by id). `transferList` moves buffers zero-copy into the
  // worker (used by the Float64Array load fast path).
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

export { decodeQueryResult, decodeHybridResult } from './decode.js';
