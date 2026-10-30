// Browser module worker for the compare page's js-worker column.
//
// The compare page's right map can run the reference `supercluster` npm
// package behind a Web Worker — the browser counterpart of the bench
// js-worker harness (bench/js/worker.js is worker_threads-only; the browser
// needs a module worker with the same message protocol). The structured
// clone of the GeoJSON feature array into this worker (postMessage) is the
// js-worker input tax, measured as-is; the object-graph clone of the result
// features back is the return tax.
//
// This file is demo-only: it does not touch deployment `js/` or bench/.

// Import maps do NOT apply inside module workers (Chrome 138), so bare
// specifiers ('supercluster', and 'kdbush' inside its ESM entry) cannot
// resolve here. The UMD dist bundle (dist/supercluster.js) bundles kdbush
// inline — no bare imports — but as a non-module script it only sets
// globalThis.Supercluster. Load it via importScripts-equivalent: for module
// workers, dynamic-import the UMD as a module (its `this` is undefined, so
// it takes the globalThis branch) and read the global it sets.
let SC = globalThis.Supercluster;
if (!SC) {
  await import('/node_modules/supercluster/dist/supercluster.js');
  SC = globalThis.Supercluster;
}
SC = typeof SC === 'function' ? SC : SC.default;

// Translate the demo's Aggregation Spec into the npm package's native
// map/reduce aggregation options (same translation as demo/engines.js's
// main-thread js engine — cluster properties must match the WASM side's so
// the compare page's labels render identically). The callbacks' cost is
// part of the js-worker's load time, measured as-is.
function specToMapReduce(options) {
  const fields = Array.isArray(options?.aggregation?.fields) ? options.aggregation.fields : [];
  const opts = { ...options };
  delete opts.aggregation;
  if (fields.length) {
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

let index = null;

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
    case 'load': {
      try {
        // A fresh index per load mirrors the deployment pattern (one index
        // per worker lifetime) and the WASM side's discipline.
        index = new SC({ ...specToMapReduce(msg.options), log: false });
        index.load(msg.points);
        postMessage({ id: msg.id, type: 'load', ok: true });
      } catch (err) {
        postMessage({ id: msg.id, type: 'load', ok: false, error: String(err && err.message || err) });
      }
      return;
    }
    case 'getClusters': {
      if (!index) return fail(msg, 'index not loaded');
      postMessage({ id: msg.id, type: 'getClusters', features: index.getClusters(msg.bbox, msg.zoom) });
      return;
    }
    case 'getClusterExpansionZoom': {
      if (!index) return fail(msg, 'index not loaded');
      postMessage({
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
  postMessage({ id: msg.id, type: msg.type, ok: false, error });
}
