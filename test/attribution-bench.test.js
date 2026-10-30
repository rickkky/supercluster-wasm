// Tier 3 (ticket 09): attribution harness smoke test.
//
// Runs the worker-wired attribution harness at SMALL=1 (10k points) and
// asserts it emits finite, positive absolute ms/query + a per-layer
// attribution that sums consistently with the worker-wired total. Guards the
// harness plumbing (echo worker, raw worker, the three isolated layers, the
// ATTRIBUTION_JSON stderr line) against regressions without paying the 1M/6M
// cost on every CI run.
//
// No ratio thresholds are asserted here — the absolute numbers depend on the
// host and would flake CI. The full 1M/6M attribution is run manually via
// `pnpm bench:attribution` and recorded in the ticket answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const RUN = join(REPO, 'bench', 'attribution', 'run.js');

// Spawn the attribution harness with SMALL=1, capture stdout + stderr.
function runHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=8192', RUN],
      { cwd: REPO, env: { ...process.env, SMALL: '1' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

// Extract the ATTRIBUTION_JSON payload from the harness's stderr.
function parseAttribution(stderr) {
  const m = stderr.match(/ATTRIBUTION_JSON=(\[[\s\S]*\])\s*$/m);
  assert.ok(m, 'ATTRIBUTION_JSON= line present on stderr');
  return JSON.parse(m[1]);
}

test('bench:attribution SMALL=1 emits finite absolutes + per-layer attribution', async () => {
  const { stdout, stderr, code } = await runHarness();
  assert.equal(code, 0, `harness exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

  const results = parseAttribution(stderr);

  // Two datasets (uniform-random + clustered-synthetic) at 10k.
  assert.equal(results.length, 2, `expected 2 datasets, got ${results.length}`);

  for (const r of results) {
    // Load-input layer (per-load, not per-query): finite + non-negative.
    assert.ok(typeof r.load_input_clone_ms === 'number' && Number.isFinite(r.load_input_clone_ms) && r.load_input_clone_ms >= 0, `${r.dataset}: load_input_clone_ms not finite/non-negative: ${r.load_input_clone_ms}`);
    assert.ok(typeof r.load_input_transfer_ms === 'number' && Number.isFinite(r.load_input_transfer_ms) && r.load_input_transfer_ms >= 0, `${r.dataset}: load_input_transfer_ms not finite/non-negative: ${r.load_input_transfer_ms}`);
    // The coordinate array byte size is n*2*8 (Float64 pairs).
    assert.equal(r.coord_array_bytes, r.n * 2 * 8, `${r.dataset}: coord_array_bytes wrong`);

    // Two viewport shapes per dataset (cluster-dense + point-dense).
    assert.equal(r.shapes.length, 2, `${r.dataset}: expected 2 shapes, got ${r.shapes.length}`);

    for (const s of r.shapes) {
      // Worker-wired absolute ms/query — the headline (first recorded
      // absolutes for this column). Finite + positive.
      assert.ok(typeof s.worker_wired_ms_per_query === 'number' && Number.isFinite(s.worker_wired_ms_per_query) && s.worker_wired_ms_per_query > 0, `${r.dataset}/${s.label}: worker_wired not finite/positive: ${s.worker_wired_ms_per_query}`);
      // Each attributed layer finite + non-negative.
      for (const layer of ['ffi_compute_ms_per_query', 'result_buffer_ms_per_query', 'decode_ms_per_query', 'ipc_floor_ms_per_query']) {
        const v = s[layer];
        assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0, `${r.dataset}/${s.label}: ${layer} not finite/non-negative: ${v}`);
      }
      // The IPC floor and the worker-wired total are measured on separate
      // timer passes (the echo worker vs. the real worker), so at 10k scale
      // (sub-0.05 ms) run-to-run variance can put the floor slightly above the
      // worker-wired total. We assert it's in the same order of magnitude
      // (within 3x) rather than strictly <= — a true warmup regression would
      // make the floor 10x+ the worker-wired (the un-warmed cold path), which
      // this still catches. The robust signal is the attributed-sum check
      // below.
      assert.ok(s.ipc_floor_ms_per_query <= 3 * s.worker_wired_ms_per_query, `${r.dataset}/${s.label}: ipc floor (${s.ipc_floor_ms_per_query}) >> worker-wired (${s.worker_wired_ms_per_query}) — warmup regression`);
      // The attributed sum (result-buf + decode + ipc-floor) should be in the
      // ballpark of the worker-wired total (within 2x — the layers are
      // measured on separate timer passes, so exact equality is not expected;
      // a sum that diverges by >2x signals a measurement bug).
      const sum = s.result_buffer_ms_per_query + s.decode_ms_per_query + s.ipc_floor_ms_per_query;
      assert.ok(sum > 0, `${r.dataset}/${s.label}: attributed sum is zero`);
      const ratio = sum / s.worker_wired_ms_per_query;
      assert.ok(ratio <= 2, `${r.dataset}/${s.label}: attributed sum (${sum.toFixed(4)}) >> worker-wired (${s.worker_wired_ms_per_query.toFixed(4)}) — measurement bug (ratio ${ratio.toFixed(2)})`);
      // Result count must be a non-negative integer.
      assert.ok(Number.isInteger(s.result_count) && s.result_count >= 0, `${r.dataset}/${s.label}: result_count not a non-negative integer: ${s.result_count}`);
    }
  }
});
