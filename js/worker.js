// Tier 4 (ticket 07): the Web Worker that owns the WASM index.
//
// This is an ESM module worker (instantiated from the main thread with
// `{ type: 'module' }`). It loads the wasm-pack output (`../pkg/supercluster.js`
// + `../pkg/supercluster_bg.wasm`), wraps a single `SuperclusterWasm`, and
// exposes the API as promise-correlated postMessage requests.
//
// Message protocol (main -> worker, every request carries `id` + `type`):
//   { id, type: 'load', points, options }
//     — `points` as a Float64Array arrives with its buffer TRANSFERRED
//       (zero-copy; the main thread's copy is detached, ticket 11) and routes
//       to `load_coords`; GeoJSON input arrives structured-cloned and routes
//       to `load`.
//   { id, type: 'getClusters', bbox: [minLng,minLat,maxLng,maxLat], zoom }
//   { id, type: 'getClustersIds', bbox: [minLng,minLat,maxLng,maxLat], zoom }
//   { id, type: 'getChildren', clusterId }
//   { id, type: 'getLeaves', clusterId, limit: number|null, offset }
//   { id, type: 'getClusterExpansionZoom', clusterId }
//
// Responses (worker -> main):
//   { id, type: 'load', ok: true }
//   { id, type: 'load', ok: false, error }
//   { id, type: 'getClusters'|'getChildren'|'getLeaves', count, rows, aggregated, specLen }
//   { id, type: 'getClustersIds', point_ids, cluster_rows, cluster_aggregated, count, specLen }
//   { id, type: 'getClusterExpansionZoom', zoom }
//   { id, type: <req>, ok: false, error }   // edge/parse errors
//
// Typed-array transfer: the wasm-bindgen `Float64Array::view`s/`Uint32Array::view`s
// are views into WASM linear memory, which cannot be transferred. The worker
// copies each view into a fresh typed array and transfers the copy's buffer.

import init, { SuperclusterWasm } from '../pkg/supercluster.js';

let wasm;
let specFieldNames = [];
let loaded = false;

// Initialize the WASM module once at worker boot. The wasm binary is resolved
// relative to this module's URL so the worker can be served from any path.
// `init()` fetches/instantiates the .wasm and binds the `wasm.*` exports, so
// `new SuperclusterWasm()` (which calls `wasm.superclusterwasm_new`) MUST run
// only after init resolves — constructing before it would hit undefined exports.
await init(new URL('../pkg/supercluster_bg.wasm', import.meta.url));
wasm = new SuperclusterWasm();
postMessage({ type: 'ready' });

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || typeof msg.id !== 'number') return;
  handle(msg).catch((err) => {
    postMessage({ id: msg.id, type: msg.type, ok: false, error: String(err && err.message || err) });
  });
};

async function handle(msg) {
  switch (msg.type) {
    case 'load':
      return load(msg);
    case 'getClusters':
      return query(msg, (bbox, zoom) => wasm.get_clusters(bbox, zoom), 'getClusters');
    case 'getClustersIds':
      return queryIds(msg, (bbox, zoom) => wasm.get_clusters_ids(bbox, zoom));
    case 'getChildren':
      return query(msg, () => wasm.get_children(msg.clusterId >>> 0), 'getChildren');
    case 'getLeaves':
      return query(msg, () => wasm.get_leaves(msg.clusterId >>> 0, msg.limit, msg.offset | 0), 'getLeaves');
    case 'getClusterExpansionZoom':
      return expansionZoom(msg);
    default:
      postMessage({ id: msg.id, type: msg.type, ok: false, error: `unknown request type: ${msg.type}` });
  }
}

function load(msg) {
  const points = msg.points;
  const options = msg.options ?? {};
  try {
    // Fast path: a pre-flattened Float64Array of [lng, lat, ...] bypasses the
    // GeoJSON parse (the measured load bottleneck — per-feature Reflect::get
    // FFI). `load_coords` does one typed-array copy + a pure-Rust build. The
    // GeoJSON `load` path stays for FeatureCollection/Feature[] input.
    if (points instanceof Float64Array) {
      wasm.load_coords(points, options);
    } else {
      wasm.load(points, options);
    }
    loaded = true;
    // Capture the spec field names so the main thread can decode aggregated
    // values by name. The options object is the source of truth here.
    specFieldNames = Array.isArray(options?.aggregation?.fields)
      ? options.aggregation.fields.map((f) => f.name)
      : [];
    postMessage({ id: msg.id, type: 'load', ok: true });
  } catch (err) {
    postMessage({ id: msg.id, type: 'load', ok: false, error: String(err && err.message || err) });
  }
}

function query(msg, run, responseType) {
  if (!loaded) {
    postMessage({ id: msg.id, type: responseType, ok: false, error: 'index not loaded' });
    return;
  }
  let res;
  try {
    res = run(msg.bbox, msg.zoom);
  } catch (err) {
    postMessage({ id: msg.id, type: responseType, ok: false, error: String(err && err.message || err) });
    return;
  }
  // res is { count, rows: Float64Array(view), aggregated: Float64Array(view),
  // specLen }. Copy the views into owned Float64Arrays and transfer them.
  const count = res.count;
  const rows = new Float64Array(res.rows); // copy out of WASM memory
  const aggregated = new Float64Array(res.aggregated);
  const specLen = res.specLen;
  postMessage(
    { id: msg.id, type: responseType, count, rows, aggregated, specLen },
    [rows.buffer, aggregated.buffer],
  );
}

// The hybrid id+encoded fast path (ticket 10): `get_clusters_ids` returns
// { point_ids: Uint32Array(view), cluster_rows: Float64Array(view),
//   cluster_aggregated: Float64Array(view), count, specLen }. Point rows are
// source-feature ids only (the main thread indexes its own source features —
// zero per-row encode); cluster rows are encoded via the existing encoder
// (Clusters are synthesized inside WASM with no main-thread source feature, so
// their lng/lat/num_points/aggregated must cross encoded). Copy the views into
// owned typed arrays and transfer all three buffers.
function queryIds(msg, run) {
  if (!loaded) {
    postMessage({ id: msg.id, type: 'getClustersIds', ok: false, error: 'index not loaded' });
    return;
  }
  let res;
  try {
    res = run(msg.bbox, msg.zoom);
  } catch (err) {
    postMessage({ id: msg.id, type: 'getClustersIds', ok: false, error: String(err && err.message || err) });
    return;
  }
  const count = res.count;
  const specLen = res.specLen;
  const pointIds = new Uint32Array(res.point_ids); // copy out of WASM memory
  const clusterRows = new Float64Array(res.cluster_rows);
  const clusterAggregated = new Float64Array(res.cluster_aggregated);
  postMessage(
    {
      id: msg.id,
      type: 'getClustersIds',
      count,
      specLen,
      point_ids: pointIds,
      cluster_rows: clusterRows,
      cluster_aggregated: clusterAggregated,
    },
    [pointIds.buffer, clusterRows.buffer, clusterAggregated.buffer],
  );
}

function expansionZoom(msg) {
  if (!loaded) {
    postMessage({ id: msg.id, type: 'getClusterExpansionZoom', ok: false, error: 'index not loaded' });
    return;
  }
  let zoom;
  try {
    zoom = wasm.get_cluster_expansion_zoom(msg.clusterId >>> 0);
  } catch (err) {
    postMessage({ id: msg.id, type: 'getClusterExpansionZoom', ok: false, error: String(err && err.message || err) });
    return;
  }
  postMessage({ id: msg.id, type: 'getClusterExpansionZoom', zoom });
}
