// Tier 3 (ticket 12): js-worker harness smoke test.
//
// Runs the js-worker harness at SMALL=1 (10k points) and asserts it produces
// a parseable JS_WORKER_SUMMARY_JSON with finite, positive per-query timings
// and non-zero result counts. This guards the new harness plumbing (the
// worker_threads port holding JS supercluster, the promise-correlated
// protocol, the warmup + median-of-3 discipline) against regressions without
// paying the 1M/6M cost on every CI run.
//
// No ratio thresholds are asserted — absolute times depend on the host and
// would flake CI. The full 1M/6M run is manual via `pnpm bench:js` and the
// numbers are recorded in the ticket answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const RUN = join(REPO, 'bench', 'js', 'run.js');

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

test('bench:js SMALL=1 produces finite timings + non-zero counts', async () => {
  const { stdout, stderr, code } = await runHarness();
  assert.equal(code, 0, `harness exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

  const m = stderr.match(/JS_WORKER_SUMMARY_JSON=(\[[^\n]*\])\s*$/m);
  assert.ok(m, 'JS_WORKER_SUMMARY_JSON= line present on stderr');
  const summary = JSON.parse(m[1]);
  assert.ok(summary.length > 0, 'summary has at least one dataset row');

  for (const row of summary) {
    for (const k of [
      'getClusters_small_ms_per_query',
      'getClusters_world_ms_per_query',
      'getChildren_ms_per_query',
      'getLeaves_ms_per_query',
    ]) {
      const v = row[k];
      assert.ok(v != null && Number.isFinite(v) && v > 0, `${row.dataset} ${k} not finite positive: ${v}`);
    }
    assert.ok(row.load_ms > 0, `${row.dataset} load_ms not positive: ${row.load_ms}`);
    assert.ok(row.getClusters_small_count > 0, `${row.dataset} small count is zero`);
    assert.ok(row.getClusters_world_count > 0, `${row.dataset} world count is zero`);
  }
});
