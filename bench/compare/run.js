// Comparison orchestrator (ticket 08; four-column matrix since ticket 12):
// runs the JS baseline + the JS-worker harness + the WASM harness
// (FFI-direct + worker-wired), parses the `*_SUMMARY_JSON=` / `*_GEOMEAN`
// stderr lines, computes ratio columns per kind + a geometric mean, prints
// a human table to stdout, and asserts count parity (WASM counts must equal
// the JS baseline counts — catches "WASM is fast because it returns zero").
//
// Ratios are JS/WASM (>1.0 = WASM faster). Since ticket 12 the matrix has
// four columns with a unified js-direct denominator:
//   - wasm-ffi / js-direct: the clustering-compute comparison (the gate).
//   - wasm-worker / js-direct: what a WASM consumer behind a worker pays
//     vs the JS direct call (the pre-12 "worker-wired" column).
//   - js-worker / js-direct: the pure worker tax on the SAME implementation
//     (JS behind a worker vs JS direct) — quantifies how much the worker
//     boundary costs the reference implementation itself.
//   - headline pairwise wasm-worker vs js-worker: deployment shape vs
//     deployment shape (the ticket-12 question the matrix exists to answer).
// The gate (per the spec's "both hot paths" — build + query) is the
// wasm-ffi column: `load_coords` ratio > 1.0 (the build hot path) AND the
// two viewport-query ratios > 1.0 (`getClusters_small` + `getClusters_world`).
// The drilldown queries (`getChildren`/`getLeaves`) are reported but NOT
// gated: they return 3-10 results at microsecond scale where the
// wasm-bindgen FFI boundary's ~3us fixed overhead (encode + 2x
// Float64Array::view + Object::new + Reflect::set + dispatch) dominates the
// trivial compute — baseline `getChildren` is ~1.7us (below the FFI floor),
// so WASM structurally cannot beat pure JS there. That is an FFI
// characteristic, not a clustering regression; the spec's hot paths (build +
// viewport query) are where clustering compute is measured. The three
// worker columns are informational (IPC tax expected to pull them <1.0).
//
// Run with: pnpm bench:compare   (SMALL=1 for a 10k smoke pass)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geometricMean } from '../util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

const SMALL_BBOX_LABEL = 'getClusters_small';
const WORLD_BBOX_LABEL = 'getClusters_world';
const QUERY_KINDS = [SMALL_BBOX_LABEL, WORLD_BBOX_LABEL, 'getChildren', 'getLeaves'];
const PER_QUERY_KEY = {
  [SMALL_BBOX_LABEL]: 'getClusters_small_ms_per_query',
  [WORLD_BBOX_LABEL]: 'getClusters_world_ms_per_query',
  getChildren: 'getChildren_ms_per_query',
  getLeaves: 'getLeaves_ms_per_query',
};
const COUNT_KEY = {
  [SMALL_BBOX_LABEL]: 'getClusters_small_count',
  [WORLD_BBOX_LABEL]: 'getClusters_world_count',
};

// Spawn a node script, capture stdout (human text) + stderr (machine lines).
// Resolves with { stdout, stderr, code }. Inherits the parent's env (SMALL,
// SIZES pass through) and adds the 8GB heap cap the bench scripts expect.
function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=8192', scriptPath],
      { cwd: REPO, env: { ...process.env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

// Extract the JSON value from a `KEY=<json>` line in stderr.
function parseSummaryLine(stderr, key) {
  const re = new RegExp(`${key}=(\\[?[^\\n]*\\]?)\\s*$`, 'm');
  const m = stderr.match(re);
  if (!m) return null;
  return JSON.parse(m[1]);
}

function parseGeomeanLine(stderr, key) {
  const re = new RegExp(`${key}=(\\{[^\\n]*\\})\\s*$`, 'm');
  const m = stderr.match(re);
  if (!m) return null;
  return JSON.parse(m[1]);
}

// JS/WASM ratio (>1.0 = WASM faster). Null if either side is null/<=0.
function ratio(js, wasm) {
  if (js == null || wasm == null || js <= 0 || wasm <= 0) return null;
  return js / wasm;
}

function fmt(r, digits = 2) {
  return r == null ? '  n/a' : r.toFixed(digits);
}

async function main() {
  const small = process.env.SMALL ? ' (SMALL=1)' : '';
  console.log(`supercluster-wasm — JS vs WASM comparison${small}`);
  console.log(`node ${process.version}\n`);

  // 1. Run all four. The baseline prints human text to stdout + SUMMARY_JSON
  //    + GEOMEAN_MS_PER_QUERY to stderr. The WASM harness prints both its
  //    columns; the js-worker harness prints the fourth.
  console.log('[1/4] JS baseline (js-direct) ...');
  const baseline = await runScript(join(REPO, 'bench', 'baseline', 'run.js'));
  if (baseline.code !== 0) {
    console.error(`baseline exited ${baseline.code}\n${baseline.stderr}`);
    process.exit(1);
  }
  const baselineSummary = parseSummaryLine(baseline.stderr, 'SUMMARY_JSON');
  const baselineGeomean = parseGeomeanLine(baseline.stderr, 'GEOMEAN_MS_PER_QUERY');

  console.log('[2/4] js-worker harness ...');
  const jsWorker = await runScript(join(REPO, 'bench', 'js', 'run.js'));
  if (jsWorker.code !== 0) {
    console.error(`js-worker exited ${jsWorker.code}\n${jsWorker.stderr}`);
    process.exit(1);
  }
  const jsWorkerSummary = parseSummaryLine(jsWorker.stderr, 'JS_WORKER_SUMMARY_JSON');
  const jsWorkerGeomean = parseGeomeanLine(jsWorker.stderr, 'JS_WORKER_GEOMEAN_MS_PER_QUERY');

  console.log('[3/4] WASM harness (FFI-direct + worker-wired) ...');
  const wasm = await runScript(join(REPO, 'bench', 'wasm', 'run.js'));
  if (wasm.code !== 0) {
    console.error(`wasm exited ${wasm.code}\n${wasm.stderr}`);
    process.exit(1);
  }
  const ffiSummary = parseSummaryLine(wasm.stderr, 'WASM_SUMMARY_JSON');
  const ffiGeomean = parseGeomeanLine(wasm.stderr, 'WASM_GEOMEAN_MS_PER_QUERY');
  const workerSummary = parseSummaryLine(wasm.stderr, 'WORKER_SUMMARY_JSON');
  const workerGeomean = parseGeomeanLine(wasm.stderr, 'WORKER_GEOMEAN_MS_PER_QUERY');

  // Index summaries by `${dataset}-${n}` for join.
  const indexBy = (arr) => {
    const m = new Map();
    for (const r of arr) m.set(`${r.dataset}-${r.n}`, r);
    return m;
  };
  const base = indexBy(baselineSummary);
  const jsw = indexBy(jsWorkerSummary);
  const ffi = indexBy(ffiSummary);
  const wrk = indexBy(workerSummary);

  // 2. Count-parity gate: WASM counts must equal baseline counts for each
  //    viewport query shape. Mismatch -> exit non-zero before reporting ratios.
  const mismatches = [];
  for (const [key, b] of base) {
    const f = ffi.get(key);
    const w = wrk.get(key);
    const j = jsw.get(key);
    for (const kind of [SMALL_BBOX_LABEL, WORLD_BBOX_LABEL]) {
      const ck = COUNT_KEY[kind];
      if (f && b[ck] !== f[ck]) {
        mismatches.push(`${key} ${kind}: baseline=${b[ck]} ffi=${f[ck]}`);
      }
      if (w && b[ck] !== w[ck]) {
        mismatches.push(`${key} ${kind}: baseline=${b[ck]} worker=${w[ck]}`);
      }
      if (j && b[ck] !== j[ck]) {
        mismatches.push(`${key} ${kind}: baseline=${b[ck]} js-worker=${j[ck]}`);
      }
    }
  }
  if (mismatches.length) {
    console.error('\nCOUNT PARITY FAILED — WASM result counts differ from baseline:');
    for (const m of mismatches) console.error(`  ${m}`);
    console.error('\nRatios would be meaningless (WASM may be returning zero results). Aborting.');
    process.exit(1);
  }
  console.log('\nCount parity: OK (WASM counts == baseline counts)\n');

  // 3. Per-dataset ratio table. Unified js-direct denominator (ticket 12):
  //    three ratio columns (wasm-ffi/js, wasm-worker/js, js-worker/js) +
  //    the headline pairwise (wasm-worker vs js-worker). load + load_coords
  //    (fast path) + 4 query kinds. The `load_coords` ratio is the fast-path
  //    win condition: JS baseline `load` vs WASM `load_coords` (one copy +
  //    pure-Rust build, no GeoJSON parse). The js-worker column has no
  //    `load_coords` (the JS package has no pre-flattened API — a synthetic
  //    one would not be a faithful measurement).
  const rows = [];
  for (const [key, b] of base) {
    const f = ffi.get(key);
    const w = wrk.get(key);
    const j = jsw.get(key);
    const row = { key, dataset: b.dataset, n: b.n, ffi: {}, worker: {}, jsWorker: {} };
    row.ffi.load = ratio(b.load_ms, f.load_ms);
    row.ffi.load_coords = ratio(b.load_ms, f.load_coords_ms);
    row.worker.load = ratio(b.load_ms, w.load_ms);
    // Ticket 11: the worker-wired column now measures the transferred
    // `load_coords` fast path too (the worker-wired load input is transferred
    // zero-copy, mirroring js/index.js).
    row.worker.load_coords = ratio(b.load_ms, w.load_coords_ms);
    row.jsWorker.load = ratio(b.load_ms, j.load_ms);
    for (const kind of QUERY_KINDS) {
      row.ffi[kind] = ratio(b[PER_QUERY_KEY[kind]], f[PER_QUERY_KEY[kind]]);
      row.worker[kind] = ratio(b[PER_QUERY_KEY[kind]], w[PER_QUERY_KEY[kind]]);
      row.jsWorker[kind] = ratio(b[PER_QUERY_KEY[kind]], j[PER_QUERY_KEY[kind]]);
    }
    // Headline pairwise (ticket 12): deployment shape vs deployment shape.
    // js-worker is the denominator here — >1.0 means the WASM worker beats
    // the JS worker (the fair deployment-vs-deployment comparison).
    row.headline = { load: ratio(j.load_ms, w.load_ms) };
    for (const kind of QUERY_KINDS) {
      row.headline[kind] = ratio(j[PER_QUERY_KEY[kind]], w[PER_QUERY_KEY[kind]]);
    }
    rows.push(row);
  }

  // Print table.
  const dsLabel = (r) => `${r.dataset}@${r.n.toLocaleString()}`;
  console.log('Per-dataset ratios vs js-direct (JS/WASM, >1.0 = faster than JS direct):');
  console.log('');
  console.log(
    pad('dataset', 28) +
      pad('load', 10) +
      pad('load_coords', 14) +
      pad('small', 10) +
      pad('world', 10) +
      pad('children', 10) +
      pad('leaves', 10),
  );
  console.log('-'.repeat(82));
  for (const r of rows) {
    console.log(
      pad(dsLabel(r), 28) +
        pad(fmt(r.ffi.load), 10) +
        pad(fmt(r.ffi.load_coords), 14) +
        pad(fmt(r.ffi[SMALL_BBOX_LABEL]), 10) +
        pad(fmt(r.ffi[WORLD_BBOX_LABEL]), 10) +
        pad(fmt(r.ffi.getChildren), 10) +
        pad(fmt(r.ffi.getLeaves), 10),
    );
  }
  console.log('-'.repeat(82));
  console.log('  (above: wasm-ffi column; load_coords = fast path vs JS load)');
  console.log('');
  for (const r of rows) {
    console.log(
      pad(dsLabel(r), 28) +
        pad(fmt(r.worker.load), 10) +
        pad(fmt(r.worker.load_coords), 14) +
        pad(fmt(r.worker[SMALL_BBOX_LABEL]), 10) +
        pad(fmt(r.worker[WORLD_BBOX_LABEL]), 10) +
        pad(fmt(r.worker.getChildren), 10) +
        pad(fmt(r.worker.getLeaves), 10),
    );
  }
  console.log('-'.repeat(82));
  console.log('  (above: wasm-worker column; load_coords = transferred fast path vs JS load — ticket 11)');
  console.log('');
  for (const r of rows) {
    console.log(
      pad(dsLabel(r), 28) +
        pad(fmt(r.jsWorker.load), 10) +
        pad('n/a', 14) +
        pad(fmt(r.jsWorker[SMALL_BBOX_LABEL]), 10) +
        pad(fmt(r.jsWorker[WORLD_BBOX_LABEL]), 10) +
        pad(fmt(r.jsWorker.getChildren), 10) +
        pad(fmt(r.jsWorker.getLeaves), 10),
    );
  }
  console.log('-'.repeat(82));
  console.log('  (above: js-worker column — the pure worker tax on the JS implementation itself, ticket 12)');
  console.log('');
  console.log('Headline pairwise — wasm-worker vs js-worker (>1.0 = WASM worker faster):');
  console.log('');
  for (const r of rows) {
    console.log(
      pad(dsLabel(r), 28) +
        pad(fmt(r.headline.load), 10) +
        pad('n/a', 14) +
        pad(fmt(r.headline[SMALL_BBOX_LABEL]), 10) +
        pad(fmt(r.headline[WORLD_BBOX_LABEL]), 10) +
        pad(fmt(r.headline.getChildren), 10) +
        pad(fmt(r.headline.getLeaves), 10),
    );
  }
  console.log('-'.repeat(82));
  console.log('  (above: deployment shape vs deployment shape — the ticket-12 question)');

  // 4. Geometric-mean ratios across all datasets/sizes, per kind + load.
  const ffiGeo = { load: geometricMean(rows.map((r) => r.ffi.load)), load_coords: geometricMean(rows.map((r) => r.ffi.load_coords)) };
  const wrkGeo = { load: geometricMean(rows.map((r) => r.worker.load)), load_coords: geometricMean(rows.map((r) => r.worker.load_coords)) };
  const jswGeo = { load: geometricMean(rows.map((r) => r.jsWorker.load)) };
  const headlineGeo = { load: geometricMean(rows.map((r) => r.headline.load)) };
  for (const kind of QUERY_KINDS) {
    ffiGeo[kind] = geometricMean(rows.map((r) => r.ffi[kind]));
    wrkGeo[kind] = geometricMean(rows.map((r) => r.worker[kind]));
    jswGeo[kind] = geometricMean(rows.map((r) => r.jsWorker[kind]));
    headlineGeo[kind] = geometricMean(rows.map((r) => r.headline[kind]));
  }

  console.log('\nGeometric-mean ratios (js-direct denominator, >1.0 = faster than JS direct):');
  console.log(pad('', 28) + pad('wasm-ffi', 14) + pad('wasm-worker', 14) + pad('js-worker', 14));
  console.log('-'.repeat(70));
  console.log(
    pad('load', 28) + pad(fmt(ffiGeo.load), 14) + pad(fmt(wrkGeo.load), 14) + pad(fmt(jswGeo.load), 14),
  );
  console.log(
    pad('load_coords (fast path)', 28) + pad(fmt(ffiGeo.load_coords), 14) + pad(fmt(wrkGeo.load_coords), 14) + pad('n/a', 14),
  );
  for (const kind of QUERY_KINDS) {
    console.log(
      pad(kind, 28) + pad(fmt(ffiGeo[kind]), 14) + pad(fmt(wrkGeo[kind]), 14) + pad(fmt(jswGeo[kind]), 14),
    );
  }
  console.log('\nHeadline pairwise geomean (wasm-worker vs js-worker, >1.0 = WASM worker faster):');
  console.log(
    pad('load', 28) + pad(fmt(headlineGeo.load), 14),
  );
  for (const kind of QUERY_KINDS) {
    console.log(pad(kind, 28) + pad(fmt(headlineGeo[kind]), 14));
  }

  // 5. Gate check (FFI-direct only). The spec's "both hot paths" = build +
  //    query (viewport). Gate: `load_coords` (build) + `getClusters_small` +
  //    `getClusters_world` (the two viewport queries) all > 1.0. The GeoJSON
  //    `load` ratio is reported but not gated (parse-bound, the fast path
  //    bypasses it). The drilldown queries (`getChildren`/`getLeaves`) are
  //    reported but not gated — microsecond-scale, FFI-floor-dominated (see
  //    the file header).
  const GATED_KINDS = ['load_coords', SMALL_BBOX_LABEL, WORLD_BBOX_LABEL];
  const gateFailures = [];
  for (const kind of GATED_KINDS) {
    const r = ffiGeo[kind];
    if (r == null || r <= 1.0) {
      gateFailures.push(`FFI-direct ${kind} geomean ratio = ${fmt(r)} (need >1.0)`);
    }
  }
  const gatePassed = gateFailures.length === 0;

  console.log('\n' + (gatePassed ? 'GATE: PASS' : 'GATE: FAIL'));
  if (!gatePassed) {
    for (const f of gateFailures) console.log('  ' + f);
  }
  // Report the GeoJSON load ratio for context (informational, not gated).
  console.log(`  (GeoJSON load geomean ratio: ${fmt(ffiGeo.load)} — informational, parse-bound)`);
  // Report the drilldown ratios for completeness (informational, not gated).
  console.log(`  (getChildren geomean ratio: ${fmt(ffiGeo.getChildren)} — informational, FFI-floor-dominated)`);
  console.log(`  (getLeaves geomean ratio: ${fmt(ffiGeo.getLeaves)} — informational)`);

  // 6. Machine-readable comparison on stderr for capture.
  const comparison = {
    gate_passed: gatePassed,
    wasm_ffi: { per_dataset: rows.map((r) => ({ dataset: r.dataset, n: r.n, load: r.ffi.load, load_coords: r.ffi.load_coords, getClusters_small: r.ffi[SMALL_BBOX_LABEL], getClusters_world: r.ffi[WORLD_BBOX_LABEL], getChildren: r.ffi.getChildren, getLeaves: r.ffi.getLeaves })), geomean: ffiGeo },
    wasm_worker: { per_dataset: rows.map((r) => ({ dataset: r.dataset, n: r.n, load: r.worker.load, load_coords: r.worker.load_coords, getClusters_small: r.worker[SMALL_BBOX_LABEL], getClusters_world: r.worker[WORLD_BBOX_LABEL], getChildren: r.worker.getChildren, getLeaves: r.worker.getLeaves })), geomean: wrkGeo },
    js_worker: { per_dataset: rows.map((r) => ({ dataset: r.dataset, n: r.n, load: r.jsWorker.load, getClusters_small: r.jsWorker[SMALL_BBOX_LABEL], getClusters_world: r.jsWorker[WORLD_BBOX_LABEL], getChildren: r.jsWorker.getChildren, getLeaves: r.jsWorker.getLeaves })), geomean: jswGeo },
    headline_wasm_worker_vs_js_worker: { per_dataset: rows.map((r) => ({ dataset: r.dataset, n: r.n, load: r.headline.load, getClusters_small: r.headline[SMALL_BBOX_LABEL], getClusters_world: r.headline[WORLD_BBOX_LABEL], getChildren: r.headline.getChildren, getLeaves: r.headline.getLeaves })), geomean: headlineGeo },
    baseline_geomean_ms: baselineGeomean,
    js_worker_geomean_ms: jsWorkerGeomean,
    ffi_geomean_ms: ffiGeomean,
    worker_geomean_ms: workerGeomean,
  };
  console.error('\nCOMPARISON_JSON=' + JSON.stringify(comparison));

  // Non-zero exit on gate failure so CI / the smoke test can detect it.
  process.exit(gatePassed ? 0 : 2);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
