// On-demand oracle: Rust-vs-JS membership diff at benchmark scale (1M / 6M).
//
// This is NOT a CI gate — the fixture-pinned oracle (option A, run via
// `pnpm test`) proves correctness at small scale. This script proves the Rust
// `get_clusters` membership matches JS supercluster at the benchmark datasets
// the CI fixtures cannot commit (multi-megabyte). Run manually:
//   pnpm oracle:1m-rust          (1M points per dataset)
//   SIZES=6000000 pnpm oracle:1m-rust   (6M points per dataset)
//
// For each (n, dataset, seed) triple, both sides build over identical input:
//   - JS:  bench/datasets/generate.js (the source of truth for the PRNG)
//   - Rust: the `dump-membership` binary, whose `supercluster::datasets` mirror
//     generate.js byte for byte (pinned by the integration tests).
// The two memberships are fed to the shared `diffMemberships`. The expected
// result is zero differences at every zoom — the same contract the fixture
// oracle asserts, now at scale.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlaces, loadCenters, uniformRandom, clusteredSynthetic } from '../datasets/generate.js';
import { createSuperclusterAdapter } from './adapter-supercluster.js';
import { extractMembership, diffMemberships } from './oracle.js';
import { DEFAULT_OPTIONS, ALL_ZOOMS } from './config.js';
import { parseSizes, timeMs } from '../util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// The Rust binary's release-build path. Built on demand by the `oracle:1m-rust`
// pnpm script (which runs `cargo build --release --features fixture --bin
// dump-membership` first). Release is required: the debug build is ~1000x
// slower on 1M-point indexing, making the cross-diff infeasible. Resolved
// relative to the repo root so the driver works from any CWD.
const DUMP_BIN = join(REPO_ROOT, 'target', 'release', process.platform === 'win32' ? 'dump-membership.exe' : 'dump-membership');

const SIZES = parseSizes([1_000_000]);
const OPTIONS = DEFAULT_OPTIONS;
const ZOOMS = ALL_ZOOMS;

// Each dataset triple the Rust binary accepts. `places` ignores n/seed (it is
// the fixed 163-feature corpus); the generated datasets take (n, seed). The
// seed mirrors oracle-1m.js's `1234` so the JS-vs-JS and Rust-vs-JS scale
// checks run over the same data.
const SEED = 1234;

function jsMembership(n, dataset) {
  const adapter = createSuperclusterAdapter();
  let points;
  switch (dataset) {
    case 'places': points = loadPlaces(); break;
    case 'uniform': points = uniformRandom(n, SEED); break;
    case 'clustered': points = clusteredSynthetic(n, SEED, loadCenters()); break;
    default: throw new Error(`unknown dataset ${dataset}`);
  }
  const spatialIndex = adapter.buildSpatialIndex(points, OPTIONS);
  return extractMembership(adapter, spatialIndex, ZOOMS);
}

function rustMembership(n, dataset) {
  // The binary takes <ROOT> <DATASET> <N> <SEED> and emits one JSON fixture on
  // stdout. places ignores N/SEED; pass 0/0 for those.
  const out = execFileSync(DUMP_BIN, [REPO_ROOT, dataset, String(n), String(SEED)], {
    maxBuffer: 1024 * 1024 * 1024, // 1 GiB — a 6M membership dump can be large
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  // Rekey from the JSON object (string zoom keys) into the Map<number, ...>
  // shape `diffMemberships` expects.
  const m = new Map();
  for (const z of ZOOMS) m.set(z, parsed.membership[String(z)] ?? []);
  return m;
}

function run(n, dataset) {
  process.stdout.write(`${dataset} n=${n.toLocaleString()} ... `);
  const { result: js, ms: jsMs } = timeMs(() => jsMembership(n, dataset));
  const { result: rust, ms: rustMs } = timeMs(() => rustMembership(n, dataset));
  const diff = diffMemberships(js, rust, ZOOMS);
  const status = diff.totalDifferences === 0 ? 'OK' : 'MISMATCH';
  console.log(`${status} (js ${jsMs.toFixed(0)} ms, rust ${rustMs.toFixed(0)} ms, ${diff.totalDifferences} differences)`);
  if (diff.totalDifferences !== 0) {
    for (const d of diff.differences) {
      console.log(`  zoom ${d.zoom}: onlyInA(js)=${d.onlyInA.length} onlyInB(rust)=${d.onlyInB.length}`);
    }
  }
  return { n, dataset, ...diff, jsMs, rustMs };
}

function main() {
  console.log('supercluster-wasm — on-demand Rust-vs-JS oracle at benchmark scale');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}, zooms ${ZOOMS.join(',')}`);
  const results = [];
  for (const n of SIZES) {
    results.push(run(n, 'uniform'));
    results.push(run(n, 'clustered'));
  }
  const allZero = results.every(r => r.totalDifferences === 0);
  console.log(allZero ? '\nALL ZERO — Rust get_clusters matches JS supercluster at scale.' : '\nMISMATCH DETECTED — see above.');
  process.exitCode = allZero ? 0 : 1;
}

main();
