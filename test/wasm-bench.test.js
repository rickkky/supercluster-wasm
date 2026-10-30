// Tier 3 (ticket 08): bench harness smoke test.
//
// Runs the comparison orchestrator at SMALL=1 (10k points) and asserts the
// harness produces finite, positive ratios and matching result counts. This
// guards the harness plumbing (FFI-direct + worker-wired columns, the
// orchestrator's stderr parsing, the count-parity gate) against regressions
// without paying the 1M/6M cost on every CI run.
//
// No ratio thresholds are asserted here — the absolute ratio depends on the
// host and would flake CI. The full 1M/6M gate is run manually via
// `pnpm bench:compare` and recorded in the ticket answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const COMPARE = join(REPO, 'bench', 'compare', 'run.js');

// Spawn the orchestrator with SMALL=1, capture stdout + stderr.
function runCompare() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=8192', COMPARE],
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

// Extract the COMPARISON_JSON payload from the orchestrator's stderr.
function parseComparison(stderr) {
  const m = stderr.match(/COMPARISON_JSON=(\{[\s\S]*\})\s*$/m);
  assert.ok(m, 'COMPARISON_JSON= line present on stderr');
  return JSON.parse(m[1]);
}

test('bench:compare SMALL=1 produces finite ratios + count parity', async () => {
  const { stdout, stderr, code } = await runCompare();
  // The orchestrator exits non-zero (code 2) when the FFI-direct gate fails.
  // At SMALL=1 (10k points) absolute times are sub-millisecond and V8 JIT
  // warmup dominates, so the gate is NOT expected to pass here — the real
  // gate runs at 1M/6M via `pnpm bench:compare` and is recorded in the ticket
  // answer. We only assert the plumbing: counts match + ratios finite.
  assert.ok(code === 0 || code === 2, `orchestrator exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Count parity: OK/);

  const cmp = parseComparison(stderr);

  // Every ratio (all four columns, all kinds) must be finite + positive. No
  // threshold — the absolute ratio depends on the host and would flake CI.
  // The wasm-ffi column also carries `load_coords` (the fast path); the
  // wasm-worker column carries it since ticket 11 (transferred input); the
  // js-worker column has no `load_coords` (the JS package has no
  // pre-flattened API).
  for (const col of [cmp.wasm_ffi]) {
    for (const row of col.per_dataset) {
      for (const k of ['load', 'load_coords', 'getClusters_small', 'getClusters_world', 'getChildren', 'getLeaves']) {
        const r = row[k];
        assert.ok(typeof r === 'number' && Number.isFinite(r), `wasm-ffi ${k} not finite: ${r}`);
        assert.ok(r > 0, `wasm-ffi ${k} not positive: ${r}`);
      }
    }
  }
  for (const [colName, col] of [
    ['wasm_worker', cmp.wasm_worker],
    ['js_worker', cmp.js_worker],
    ['headline_wasm_worker_vs_js_worker', cmp.headline_wasm_worker_vs_js_worker],
  ]) {
    for (const row of col.per_dataset) {
      for (const k of ['load', 'getClusters_small', 'getClusters_world', 'getChildren', 'getLeaves']) {
        const r = row[k];
        assert.ok(typeof r === 'number' && Number.isFinite(r), `${colName} ${k} not finite: ${r}`);
        assert.ok(r > 0, `${colName} ${k} not positive: ${r}`);
      }
    }
  }
});
