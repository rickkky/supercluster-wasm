// Bench-only echo worker for the attribution harness (ticket 09).
//
// This worker isolates the two pure-IPC layers of the worker-wired tax, with
// the WASM compute and decode stripped out:
//
//   - echo_clone    — structured-clone a payload of a given byte size from the
//                     main thread into the worker (no transfer). This is the
//                     `load` input-boundary tax layer in isolation: the
//                     coordinate array crossing main -> worker by copy.
//   - echo_transfer — transfer a payload of a given byte size (transferList).
//                     Zero-copy input crossing, for the ticket-11 candidate
//                     (transferList on the load input) — measured now so the
//                     baseline knows the headroom before that optimization.
//   - echo_tiny     — a near-zero-byte round trip. This is the per-call IPC
//                     dispatch floor (postMessage + event-loop wake + post back);
//                     subtracted from every other worker-wired measurement so
//                     the decode/result layers are not inflated by fixed
//                     dispatch overhead.
//
// Bench-only: does NOT touch deployment `js/`. The worker protocol will change
// in ticket 10, so instrumenting production code now would be immediately stale.
//
// The payload is an ArrayBuffer of `bytes` zeros. `echo_clone` posts it back
// (cloned both ways); `echo_transfer` transfers it back (zero-copy both ways);
// `echo_tiny` posts a 1-byte buffer back. Each handler reports the byte size it
// actually moved so the harness can assert the payload was the expected size.

import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  switch (msg.type) {
    case 'echo_clone': {
      // `msg.buf` arrived structured-cloned (a copy landed in the worker).
      const size = msg.buf?.byteLength ?? 0;
      parentPort.postMessage({ id: msg.id, type: 'echo_clone', size });
      break;
    }
    case 'echo_transfer': {
      // `msg.buf` arrived transferred (zero-copy move; the main thread no
      // longer owns it). Transfer it straight back so the main thread owns it
      // again — transfer is move-semantics, so the buffer must go somewhere
      // or it leaks. The harness allocates a fresh ArrayBuffer each call
      // (measureLoadInputTransfer), so it does not reuse the returned buffer,
      // but the transfer-back is still required to avoid orphaning it in the
      // worker. `buf` is a raw ArrayBuffer (not a Node Buffer).
      const buf = msg.buf ?? new ArrayBuffer(0);
      const size = buf.byteLength ?? 0;
      parentPort.postMessage({ id: msg.id, type: 'echo_transfer', size }, [buf]);
      break;
    }
    case 'echo_tiny': {
      parentPort.postMessage({ id: msg.id, type: 'echo_tiny', size: 0 });
      break;
    }
    default:
      parentPort.postMessage({
        id: msg.id,
        type: msg.type,
        ok: false,
        error: `unknown echo type: ${msg.type}`,
      });
  }
});
