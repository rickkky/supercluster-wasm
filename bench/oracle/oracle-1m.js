// On-demand oracle: JS-vs-JS membership diff at benchmark scale (1M / 6M).
//
// This is NOT a CI gate — it proves the machinery scales to the benchmark
// datasets, not that it is correct (the self-verify gate does that cheaply).
// Run manually: pnpm oracle:1m   (or SIZES=6000000 pnpm oracle:1m for 6M)
//
// The expected result is always zero differences (JS-vs-JS, same options),
// because supercluster is deterministic in isolation. A non-zero result here
// would indicate either a machinery bug or concurrent corruption — both of
// which the self-verify gate should already catch at small scale.

import { loadCenters, uniformRandom, clusteredSynthetic } from '../datasets/generate.js';
import { createSuperclusterAdapter } from './adapter-supercluster.js';
import { runOracle } from './oracle.js';
import { DEFAULT_OPTIONS, ALL_ZOOMS } from './config.js';
import { parseSizes, timeMs } from '../util.js';

const SIZES = parseSizes([1_000_000]);
const OPTIONS = DEFAULT_OPTIONS;
const ZOOMS = ALL_ZOOMS;

function run(n, kind, points) {
  const adapter = createSuperclusterAdapter();
  process.stdout.write(`${kind} n=${n.toLocaleString()} ... `);
  const { result, ms } = timeMs(() => runOracle(adapter, adapter, points, OPTIONS, OPTIONS, ZOOMS));
  const status = result.totalDifferences === 0 ? 'OK' : 'MISMATCH';
  console.log(`${status} (${ms.toFixed(0)} ms, ${result.totalDifferences} differences)`);
  if (result.totalDifferences !== 0) {
    for (const d of result.differences) {
      console.log(`  zoom ${d.zoom}: onlyInA=${d.onlyInA.length} onlyInB=${d.onlyInB.length}`);
    }
  }
  return { n, kind, ...result, ms };
}

function main() {
  console.log('supercluster-wasm — on-demand JS-vs-JS oracle at benchmark scale');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}, zooms ${ZOOMS.join(',')}`);
  const centers = loadCenters();
  const results = [];
  for (const n of SIZES) {
    results.push(run(n, 'uniform-random', uniformRandom(n, 1234)));
    results.push(run(n, 'clustered-synthetic', clusteredSynthetic(n, 1234, centers)));
  }
  const allZero = results.every(r => r.totalDifferences === 0);
  console.log(allZero ? '\nALL ZERO — machinery proven at scale.' : '\nMISMATCH DETECTED — see above.');
  process.exitCode = allZero ? 0 : 1;
}

main();
