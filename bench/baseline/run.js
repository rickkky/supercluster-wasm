// JS supercluster baseline runner.
//
// Establishes the falsifiable performance baseline that every downstream
// ticket validates against. Replicates refs/supercluster/bench.js's uniform-
// random configuration (1M points, lng [-180,180) / lat [-80,80), maxZoom 6),
// extends it to 6M for a boundary point, and adds the clustered-synthetic
// dataset (Natural Earth populated-places centers, Gaussian-sampled,
// population-weighted).
//
// For each dataset it reports:
//   - load() total time (the build hot path);
//   - getClusters query timings (small bbox + whole-world bbox);
//   - getChildren / getLeaves drill-down timings.
//
// Output is plain text to stdout, suitable for piping into the comparison
// harness in a later ticket. Run with: pnpm bench:baseline
//
// Sizes are configurable via SIZES=<n> env var (comma-separated), defaulting to
// 1M and 6M. Set SMALL=1 to run a quick smoke pass at 10k instead.

import Supercluster from 'supercluster';
import { uniformRandom, clusteredSynthetic, loadCenters } from '../datasets/generate.js';
import { parseSizes, timeMs, geometricMean } from '../util.js';
import { DEFAULT_OPTIONS } from '../oracle/config.js';

const SIZES = parseSizes(process.env.SMALL ? [10_000] : [1_000_000, 6_000_000]);

const OPTIONS = DEFAULT_OPTIONS; // matches refs/supercluster/bench.js (maxZoom 6)

// A small bbox centered on a populated region (US east coast) and the
// whole-world bbox, to exercise both selective and full-scan query paths.
const SMALL_BBOX = [-90, 25, -70, 45];
const WORLD_BBOX = [-180, -90, 180, 90];

function timeLoad(points) {
  const { result: index, ms } = timeMs(() =>
    new Supercluster({ ...OPTIONS, log: false }).load(points));
  return { index, elapsed: ms };
}

function timeGetClusters(index, bbox, zoom, batches = 100) {
  const { result: last, ms } = timeMs(() => {
    let l;
    for (let i = 0; i < batches; i++) l = index.getClusters(bbox, zoom);
    return l;
  });
  return { elapsed: ms, perQuery: ms / batches, lastCount: last ? last.length : 0 };
}

function pickClusterId(index) {
  // Find a cluster at zoom 0 to drill into. Whole-world query at z=0 returns
  // the top-level lattice; pick the first feature that is a cluster.
  const top = index.getClusters(WORLD_BBOX, 0);
  for (const f of top) {
    if (f.properties && f.properties.cluster) return f.properties.cluster_id;
  }
  return null;
}

function timeDrilldown(index, clusterId) {
  if (clusterId == null) return { children: null, leaves: null };
  const batches = 100;

  const { result: children, ms: childrenMs } = timeMs(() => {
    let c;
    for (let i = 0; i < batches; i++) c = index.getChildren(clusterId);
    return c;
  });

  const { result: leaves, ms: leavesMs } = timeMs(() => {
    let l;
    for (let i = 0; i < batches; i++) l = index.getLeaves(clusterId, 10, 0);
    return l;
  });

  return {
    children: { elapsed: childrenMs, perQuery: childrenMs / batches, count: children ? children.length : 0 },
    leaves: { elapsed: leavesMs, perQuery: leavesMs / batches, count: leaves ? leaves.length : 0 },
  };
}

function runDataset(name, points) {
  console.log(`\n=== ${name} (${points.length.toLocaleString()} points) ===`);
  const { index, elapsed: loadMs } = timeLoad(points);
  console.log(`  load:            ${loadMs.toFixed(0)} ms`);

  const small = timeGetClusters(index, SMALL_BBOX, 6);
  console.log(`  getClusters small bbox x100: ${small.elapsed.toFixed(2)} ms (${small.perQuery.toFixed(3)} ms/query, ${small.lastCount} results)`);

  const world = timeGetClusters(index, WORLD_BBOX, 0);
  console.log(`  getClusters world    x100: ${world.elapsed.toFixed(2)} ms (${world.perQuery.toFixed(3)} ms/query, ${world.lastCount} results)`);

  const clusterId = pickClusterId(index);
  const drill = timeDrilldown(index, clusterId);
  if (drill.children) {
    console.log(`  getChildren x100:         ${drill.children.elapsed.toFixed(2)} ms (${drill.children.perQuery.toFixed(3)} ms/query, ${drill.children.count} children)`);
    console.log(`  getLeaves   x100:         ${drill.leaves.elapsed.toFixed(2)} ms (${drill.leaves.perQuery.toFixed(3)} ms/query, ${drill.leaves.count} leaves)`);
  } else {
    console.log(`  (no top-level cluster to drill into)`);
  }
  return { name, count: points.length, loadMs, small, world, drill };
}

function main() {
  console.log('supercluster-wasm — JS supercluster baseline');
  console.log(`node ${process.version}, options ${JSON.stringify(OPTIONS)}`);

  const centers = loadCenters();
  const results = [];

  for (const n of SIZES) {
    // Uniform-random: matches refs/supercluster/bench.js exactly.
    const uniform = uniformRandom(n, 1234);
    results.push(runDataset(`uniform-random`, uniform));

    // Clustered-synthetic: same N, real map shapes.
    const clustered = clusteredSynthetic(n, 1234, centers);
    results.push(runDataset(`clustered-synthetic`, clustered));
  }

  // Compact machine-readable summary on stderr for later comparison tooling.
  const summary = results.map(r => ({
    dataset: r.name, n: r.count,
    load_ms: Number(r.loadMs.toFixed(0)),
    getClusters_small_ms_per_query: Number(r.small.perQuery.toFixed(3)),
    getClusters_world_ms_per_query: Number(r.world.perQuery.toFixed(3)),
    getChildren_ms_per_query: r.drill.children ? Number(r.drill.children.perQuery.toFixed(3)) : null,
    getLeaves_ms_per_query: r.drill.leaves ? Number(r.drill.leaves.perQuery.toFixed(3)) : null,
    // Result counts: the comparison orchestrator (ticket 08) asserts these
    // match the WASM side per query shape, so "WASM is fast" can't hide
    // "WASM returns zero results". Small-bbox + world-bbox counts are the
    // viewport queries; drilldown counts vary by cluster id and are not
    // parity-checked (the WASM pickClusterId may select a different cluster).
    getClusters_small_count: r.small.lastCount,
    getClusters_world_count: r.world.lastCount,
  }));
  console.error('\nSUMMARY_JSON=' + JSON.stringify(summary));

  // Geometric mean of per-query timings across all datasets/sizes, per query
  // kind. The spec asks for "geometric mean + JS/WASM ratio"; the ratio is
  // deferred until a WASM implementation exists (ticket 07+), but the
  // geometric-mean baseline is reported now so the comparison is falsifiable
  // from the first WASM run. Geometric mean is the right aggregator for
  // ratios (a later JS/WASM ratio is itself a multiplicative quantity).
  const perQueryKinds = ['getClusters_small', 'getClusters_world', 'getChildren', 'getLeaves'];
  const geoMeans = {};
  for (const kind of perQueryKinds) {
    const samples = results
      .map(r => {
        if (kind === 'getClusters_small') return r.small.perQuery;
        if (kind === 'getClusters_world') return r.world.perQuery;
        if (kind === 'getChildren') return r.drill.children?.perQuery;
        if (kind === 'getLeaves') return r.drill.leaves?.perQuery;
        return null;
      })
      .filter(v => v != null && v > 0);
    geoMeans[kind] = geometricMean(samples);
  }
  console.error('GEOMEAN_MS_PER_QUERY=' + JSON.stringify(geoMeans, null, 0));
}

main();
