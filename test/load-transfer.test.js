// Tier 3 (ticket 11): the load-input transferList round-trip.
//
// The worker-wired `load` input boundary crossing is the dominant *absolute*
// worker-wired cost at 6M (87-151 ms structured-clone per load; ticket 09
// attribution). The fix: the main-thread `load(Float64Array)` fast path
// transfers the coordinate buffer into the worker (transferList) instead of
// structured-cloning it — zero-copy. These tests guard the plumbing
// end-to-end:
//   1. The production wrapper (js/index.js) transfers the buffer — the
//      source detaches (transfer semantics, documented in the API) and the
//      index answers queries. (The production worker js/worker.js needs the
//      wasm-pack pkg/ build, so the worker-protocol mechanics are exercised
//      through the bench port, which is a faithful copy of the same
//      handlers — test 2.)
//   2. The bench worker port (bench/wasm/worker-thread.js, the
//      worker_threads adapter of js/worker.js) accepts a Float64Array posted
//      WITH a transferList (routes to `load_coords`, answers queries) and
//      WITHOUT one (the structured-clone path a caller who keeps the array
//      re-usable can still use at the protocol level).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const WORKER = join(REPO, 'bench', 'wasm', 'worker-thread.js');

// A tiny deterministic dataset: 100 points on a lattice, flat [lng, lat, ...].
function flatCoords(n) {
  const flat = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    flat[i * 2] = -180 + (360 * (i % 10)) / 10;
    flat[i * 2 + 1] = -90 + (180 * Math.floor(i / 10)) / 5;
  }
  return flat;
}

// Boot the bench worker port and return a minimal promise-correlated client
// (mirrors the deployment wrapper's #send/#onmessage shape).
async function bootWorker() {
  const worker = new Worker(WORKER);
  const pending = new Map();
  let nextId = 1;
  worker.on('message', (msg) => {
    if (msg && msg.type === 'ready') return; // boot signal, not a response
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.resolve(msg);
  });
  await new Promise((resolve, reject) => {
    const onReady = (msg) => {
      if (msg && msg.type === 'ready') {
        worker.off('message', onReady);
        resolve();
      }
    };
    worker.on('message', onReady);
    worker.once('error', reject);
  });
  return {
    send(type, payload, transferList) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, { resolve });
        worker.postMessage({ id, type, ...payload }, transferList ?? []);
      });
    },
    terminate: () => worker.terminate(),
  };
}

test('load(Float64Array) via transferList: buffer detaches, index builds, queries answer', async () => {
  const sc = await bootWorker();
  try {
    const flat = flatCoords(100);
    const buf = flat.buffer;
    const res = await sc.send('load', { points: flat, options: {} }, [buf]);
    assert.ok(res.ok, `load failed: ${res.error}`);

    // Transfer semantics: the source buffer is detached on the main thread.
    assert.equal(buf.byteLength, 0, 'source ArrayBuffer should be detached after transfer');
    assert.equal(flat.length, 0, 'source Float64Array should be neutered after transfer');

    // The index built from the transferred buffer must answer queries.
    const q = await sc.send('getClusters', { bbox: [-180, -90, 180, 90], zoom: 0 });
    assert.ok(q.ok !== false, `getClusters failed: ${q.error}`);
    assert.ok(q.count > 0, 'world-bbox query should return results');
    assert.ok(q.rows instanceof Float64Array && q.rows.length > 0, 'rows buffer transferred');

    const ids = await sc.send('getClustersIds', { bbox: [-180, -90, 180, 90], zoom: 0 });
    assert.ok(ids.ok !== false, `getClustersIds failed: ${ids.error}`);
    assert.equal(ids.count, q.count, 'hybrid path count parity with encoded path');
  } finally {
    await sc.terminate();
  }
});

test('load(Float64Array) WITHOUT transferList still works (clone path unchanged)', async () => {
  const sc = await bootWorker();
  try {
    // No transferList: the structured-clone path (a caller who keeps the
    // array re-usable can post without transferring — the worker copies).
    const flat = flatCoords(100);
    const res = await sc.send('load', { points: flat, options: {} });
    assert.ok(res.ok, `load failed: ${res.error}`);
    // Clone semantics: the source stays intact on the main thread.
    assert.equal(flat.length, 200, 'source Float64Array should survive a clone load');

    const q = await sc.send('getClusters', { bbox: [-180, -90, 180, 90], zoom: 0 });
    assert.ok(q.ok !== false, `getClusters failed: ${q.error}`);
    assert.ok(q.count > 0, 'world-bbox query should return results');
  } finally {
    await sc.terminate();
  }
});

test('production js/index.js load(Float64Array) transfers the buffer (detach semantics)', async () => {
  // js/index.js spawns a browser-style module Worker over the wasm-pack pkg/
  // build — not available under plain Node worker_threads. The transfer
  // semantics live entirely in the wrapper's postMessage call, so assert
  // them statically: the Float64Array branch must pass a transferList
  // containing the points buffer. (The runtime mechanics — detach + the
  // worker accepting a transferred buffer — are pinned by test 1 on the
  // faithful worker port.)
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(join(REPO, 'js', 'index.js'), 'utf8'),
  );
  assert.ok(
    src.includes('[points.buffer]'),
    'js/index.js load(Float64Array) must post with [points.buffer] in the transferList',
  );
});
