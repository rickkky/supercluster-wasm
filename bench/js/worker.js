// Bench-only Node `worker_threads` adapter holding the JS supercluster
// baseline implementation (ticket 12, the js-worker column).
//
// This is the JS-side counterpart of `bench/wasm/worker-thread.js`: the same
// promise-correlated message protocol (`{id, type, ...payload}` requests,
// `{id, type, ok, ...}` responses), but the index is the reference
// `supercluster` npm package instead of the WASM build. Its purpose is the
// symmetric worker comparison — until now the worker-wired column compared
// "WASM behind IPC" against "JS direct on the main thread"; this worker lets
// the compare orchestrator report deployment shape vs deployment shape
// (wasm-worker vs js-worker).
//
// Handlers mirror the protocol surface the WASM worker exposes, restricted to
// what the JS implementation natively supports:
//   - load: GeoJSON Feature[] in, structured-cloned by postMessage (that
//     clone IS the js-worker input tax — it is not bypassed).
//   - getClusters / getChildren / getLeaves: GeoJSON Feature[] out, posted
//     back as-is (the object-graph clone on the way back IS the js-worker
//     return tax — no stringify/parse detour).
//   - getClusterExpansionZoom: number out.
// There is no `load_coords`/`getClustersIds` equivalent: the JS package has
// no pre-flattened or id-only API (a synthetic one would not be a faithful
// js-worker measurement).
//
// This file is bench-only: it does NOT touch deployment `js/`.

import { parentPort } from 'node:worker_threads';
import Supercluster from 'supercluster';

// The npm package's main entry is CJS; under some pnpm layouts the default
// interop wraps the class. Normalize to the constructor either way.
const SC = typeof Supercluster === 'function' ? Supercluster : Supercluster.default;

let index = null;

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
    case 'load': {
      try {
        // A fresh index per load mirrors the deployment pattern (one index
        // per worker lifetime) and the WASM worker's fresh-worker-per-load
        // bench discipline.
        index = new SC({ ...msg.options, log: false });
        index.load(msg.points);
        parentPort.postMessage({ id: msg.id, type: 'load', ok: true });
      } catch (err) {
        parentPort.postMessage({
          id: msg.id,
          type: 'load',
          ok: false,
          error: String((err && err.message) || err),
        });
      }
      return;
    }
    case 'getClusters': {
      if (!index) return fail(msg, 'index not loaded');
      parentPort.postMessage({
        id: msg.id,
        type: 'getClusters',
        features: index.getClusters(msg.bbox, msg.zoom),
      });
      return;
    }
    case 'getChildren': {
      if (!index) return fail(msg, 'index not loaded');
      parentPort.postMessage({
        id: msg.id,
        type: 'getChildren',
        features: index.getChildren(msg.clusterId >>> 0),
      });
      return;
    }
    case 'getLeaves': {
      if (!index) return fail(msg, 'index not loaded');
      parentPort.postMessage({
        id: msg.id,
        type: 'getLeaves',
        features: index.getLeaves(msg.clusterId >>> 0, msg.limit, msg.offset | 0),
      });
      return;
    }
    case 'getClusterExpansionZoom': {
      if (!index) return fail(msg, 'index not loaded');
      parentPort.postMessage({
        id: msg.id,
        type: 'getClusterExpansionZoom',
        zoom: index.getClusterExpansionZoom(msg.clusterId >>> 0),
      });
      return;
    }
    default:
      fail(msg, `unknown request type: ${msg.type}`);
  }
}

function fail(msg, error) {
  parentPort.postMessage({ id: msg.id, type: msg.type, ok: false, error });
}
