// Capture JS supercluster's per-zoom Cluster membership as JSON fixtures.
//
// The Rust query half (ticket 04) diffs its `get_clusters` membership against
// these fixtures — the JS side of the fixture-pinned oracle (option A). This
// script is the source of truth for "what JS supercluster produces": it builds
// the reference index over each seed corpus, extracts the Cluster Lattice's
// membership per zoom via the existing oracle adapter, and writes canonical
// JSON the Rust oracle loads.
//
// Re-run to regenerate:  pnpm oracle:capture
//
// Fixture shape (one file per corpus):
//   {
//     "options": { "maxZoom": 6 },
//     "pointCount": 163,
//     "geometryBearing": 162,
//     "zooms": [0,1,2,3,4,5,6],
//     "membership": {
//       "0": [ [3,7,12,...], [5], [9,44], ... ],   // one sorted-id array per top-level entry
//       "1": [ ... ],
//       ...
//     }
//   }
//
// Each membership array is sorted ascending and deduped (the adapter already
// does this). The list of arrays per zoom is the multiset the Rust oracle's
// `diff_memberships` compares against. Source ids are array indices into the
// geometry-bearing subset — the same space Rust's `source_id` uses (see the
// `04` ticket comment on the bearing-subset alignment).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlaces, loadCenters, uniformRandom, clusteredSynthetic } from '../datasets/generate.js';
import { createSuperclusterAdapter } from './adapter-supercluster.js';
import { extractMembership } from './oracle.js';
import { DEFAULT_OPTIONS, ALL_ZOOMS } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'fixtures', 'oracle');

// Each corpus: a label, the points, and the geometry-bearing count (the
// membership's source-id space). places.json includes one geometry:null
// feature; the generated corpora have none.
function corpora() {
  const places = loadPlaces();
  const centers = loadCenters();
  return [
    { label: 'places', points: places, geometryBearing: places.filter(f => f.geometry).length },
    { label: 'uniform-1000-42', points: uniformRandom(1000, 42), geometryBearing: 1000 },
    { label: 'clustered-1000-42', points: clusteredSynthetic(1000, 42, centers), geometryBearing: 1000 },
  ];
}

function capture(label, points, geometryBearing) {
  const adapter = createSuperclusterAdapter();
  const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
  const membership = extractMembership(adapter, spatialIndex, ALL_ZOOMS);
  // Map -> plain object keyed by zoom string, each value the list of sorted-id
  // arrays. JSON.stringify sorts object keys ascending for string keys, so the
  // fixture is stable across runs.
  const byZoom = {};
  for (const z of ALL_ZOOMS) {
    byZoom[String(z)] = membership.get(z);
  }
  return {
    options: DEFAULT_OPTIONS,
    pointCount: points.length,
    geometryBearing,
    zooms: ALL_ZOOMS,
    membership: byZoom,
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const { label, points, geometryBearing } of corpora()) {
    const fixture = capture(label, points, geometryBearing);
    const path = join(OUT_DIR, `${label}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    const perZoom = ALL_ZOOMS.map(z => `${z}:${fixture.membership[String(z)].length}`).join(' ');
    console.log(`${label}: ${points.length} pts (${geometryBearing} bearing), entries/zoom [${perZoom}] -> ${path}`);
  }
}

main();
