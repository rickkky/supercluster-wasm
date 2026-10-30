// Bench-only Node `worker_threads` adapter for the worker-wired column.
//
// This is a faithful port of the deployment `js/worker.js` to Node's
// `worker_threads`: `self.onmessage`/`postMessage` become `parentPort`,
// and the async-fetch `init()` becomes `initSync` over a `readFileSync` of
// the `.wasm` (Node has no `fetch` of file:// URLs by default). The message
// protocol, the load/query/expansionZoom handlers, and the copy-views-then-
// transfer logic are identical to `js/worker.js` so the IPC + decode tax the
// column surfaces is representative of what a real browser consumer pays.
//
// CAVEAT (recorded in the ticket answer + map.md): Node `worker_threads` and
// browser `Worker` `postMessage` characteristics differ, but the decode tax
// (the dominant term per query) is representative because `js/decode.js` is
// identical, and structured-clone is the same algorithm in both environments.
//
// This file is bench-only: it does NOT touch deployment `js/`.

import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { initSync, SuperclusterWasm } from '../../pkg/supercluster.js';

// Initialize the WASM module once at worker boot. `initSync` over a
// `WebAssembly.Module` compiled from the file bytes — no fetch, no async.
initSync({
  module: new WebAssembly.Module(
    readFileSync(new URL('../../pkg/supercluster_bg.wasm', import.meta.url)),
  ),
});
const wasm = new SuperclusterWasm();
let specFieldNames = [];
let loaded = false;

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  handle(msg).catch((err) => {
    parentPort.postMessage({
      id: msg.id,
      type: msg.type,
      ok: false,
      error: String((err && err.message) || err),
    });
  });
});

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
      return query(
        msg,
        () => wasm.get_leaves(msg.clusterId >>> 0, msg.limit, msg.offset | 0),
        'getLeaves',
      );
    case 'getClusterExpansionZoom':
      return expansionZoom(msg);
    default:
      parentPort.postMessage({
        id: msg.id,
        type: msg.type,
        ok: false,
        error: `unknown request type: ${msg.type}`,
      });
  }
}

function load(msg) {
  const points = msg.points;
  const options = msg.options ?? {};
  try {
    // Fast path: a pre-flattened Float64Array routes to `load_coords` (one
    // copy + pure-Rust build, no GeoJSON parse). Mirrors `js/worker.js`.
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
    parentPort.postMessage({ id: msg.id, type: 'load', ok: true });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      type: 'load',
      ok: false,
      error: String((err && err.message) || err),
    });
  }
}

function query(msg, run, responseType) {
  if (!loaded) {
    parentPort.postMessage({
      id: msg.id,
      type: responseType,
      ok: false,
      error: 'index not loaded',
    });
    return;
  }
  let res;
  try {
    res = run(msg.bbox, msg.zoom);
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      type: responseType,
      ok: false,
      error: String((err && err.message) || err),
    });
    return;
  }
  // res is { count, rows: Float64Array(view), aggregated: Float64Array(view),
  // specLen }. Copy the views into owned Float64Arrays and transfer them.
  // (WASM-memory views can't be transferred; the copy is the boundary tax.)
  const count = res.count;
  const rows = new Float64Array(res.rows); // copy out of WASM memory
  const aggregated = new Float64Array(res.aggregated);
  const specLen = res.specLen;
  parentPort.postMessage(
    { id: msg.id, type: responseType, count, rows, aggregated, specLen },
    [rows.buffer, aggregated.buffer],
  );
}

// The hybrid id+encoded fast path (ticket 10): mirrors `js/worker.js`'s
// `queryIds`. `get_clusters_ids` returns { point_ids: Uint32Array(view),
// cluster_rows: Float64Array(view), cluster_aggregated: Float64Array(view),
// count, specLen }. Copy the views into owned typed arrays and transfer all
// three buffers. (WASM-memory views can't be transferred; the copy is the
// boundary tax — identical to the deployment worker.)
function queryIds(msg, run) {
  if (!loaded) {
    parentPort.postMessage({
      id: msg.id,
      type: 'getClustersIds',
      ok: false,
      error: 'index not loaded',
    });
    return;
  }
  let res;
  try {
    res = run(msg.bbox, msg.zoom);
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      type: 'getClustersIds',
      ok: false,
      error: String((err && err.message) || err),
    });
    return;
  }
  const count = res.count;
  const specLen = res.specLen;
  const pointIds = new Uint32Array(res.point_ids); // copy out of WASM memory
  const clusterRows = new Float64Array(res.cluster_rows);
  const clusterAggregated = new Float64Array(res.cluster_aggregated);
  parentPort.postMessage(
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
    parentPort.postMessage({
      id: msg.id,
      type: 'getClusterExpansionZoom',
      ok: false,
      error: 'index not loaded',
    });
    return;
  }
  let zoom;
  try {
    zoom = wasm.get_cluster_expansion_zoom(msg.clusterId >>> 0);
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      type: 'getClusterExpansionZoom',
      ok: false,
      error: String((err && err.message) || err),
    });
    return;
  }
  parentPort.postMessage({ id: msg.id, type: 'getClusterExpansionZoom', zoom });
}
