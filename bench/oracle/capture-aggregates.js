// Capture JS supercluster's per-Cluster aggregated `sum` (scalerank) as JSON
// fixtures, for ticket 06's fixture-pinned aggregation oracle.
//
// The Rust build half (ticket 06) folds a declarative `AggregationSpec`
// (sum/count/min/max/mean) during the `_cluster` pass; the query half surfaces
// the finalized values in `get_clusters`. This script is the JS side of the
// fixture-pinned oracle (option A, mirroring `capture-membership.js`): it
// builds the reference JS supercluster index with `map`/`reduce` over
// `places.json` (radius 100 — the same configuration `refs/supercluster/test/
// test.js`'s "aggregates cluster properties with reduce" case uses), then
// captures each Cluster's `sum` keyed by `cluster_id` per zoom, via a
// whole-world `getClusters` query (adapted from `test.js`'s `getTile`-based
// assertion to `getClusters`, since `getTile` is out of scope for this library
// — spec Q6).
//
// cluster_ids are numerically interchangeable between Rust and JS (ADR 0004:
// Rust matches supercluster's `(i<<5)+(zoom+1)+points.length` encoding), so
// the fixture keys directly onto the ids Rust's `get_clusters` returns — no
// id-translation layer. The Rust test (`tests/aggregates.rs`) diffs its
// per-cluster `sum` against this fixture.
//
// Re-run to regenerate:  pnpm oracle:capture:aggregates
//
// Fixture shape (one file per corpus):
//   {
//     "options": { "maxZoom": 16, "radius": 100 },
//     "pointCount": 163,
//     "zooms": [0,1,...,16],
//     "aggregates": {
//       "0": { "<cluster_id>": <sum>, ... },   // per-cluster sum at zoom 0
//       "1": { ... },
//       ...
//     }
//   }
//
// Only Cluster entries (point_count > 1) appear; unclustered Points carry no
// aggregated properties (they surface the original feature). A cluster_id with
// no `sum` in the fixture means JS produced a cluster whose `reduce` yielded no
// `sum` property (should not happen for places.json, which every feature has a
// scalerank) — the Rust side treats a missing key as "no assertion for that id".

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlaces } from '../datasets/generate.js';
import Supercluster from 'supercluster';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'fixtures', 'oracle');

// The test.js "aggregates cluster properties with reduce" case: radius 100,
// map scalerank into {sum}, reduce by summing. maxZoom stays at supercluster's
// default (16) so every clustering zoom is captured — the Rust side builds with
// the same maxZoom.
const AGG_OPTIONS = Object.freeze({
  radius: 100,
  map: props => ({ sum: props.scalerank }),
  reduce: (a, b) => { a.sum += b.sum; },
});

// Zooms to capture: every clustering zoom [0, maxZoom] plus maxZoom+1 (the
// raw-point lattice, where there are no clusters — aggregates is empty).
function zoomsFor(maxZoom) {
  return Array.from({ length: maxZoom + 2 }, (_, z) => z);
}

// Capture per-cluster `sum` at each zoom: a whole-world `getClusters` query
// returns every top-level entry; for each Cluster, record its `sum` keyed by
// `cluster_id`. Unclustered Points are skipped (no aggregated props).
function capture(points, options) {
  const maxZoom = options.maxZoom ?? 16;
  const index = new Supercluster(options).load(points);
  const byZoom = {};
  for (const z of zoomsFor(maxZoom)) {
    const features = index.getClusters([-180, -90, 180, 90], z);
    const sums = {};
    for (const f of features) {
      const props = f.properties || {};
      if (props.cluster) {
        // JS supercluster's getClusterProperties always sets `cluster: true`
        // and `cluster_id` on cluster features; `sum` is the reduced value.
        sums[String(props.cluster_id)] = props.sum;
      }
    }
    byZoom[String(z)] = sums;
  }
  return {
    options: { maxZoom, radius: options.radius },
    pointCount: points.length,
    zooms: zoomsFor(maxZoom),
    aggregates: byZoom,
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const places = loadPlaces();
  const fixture = capture(places, AGG_OPTIONS);
  const path = join(OUT_DIR, 'aggregates-places.json');
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  // Sanity: report the cluster count per zoom so a human glancing at the log
  // sees the fixture is non-trivial.
  const counts = fixture.zooms.map(z => `${z}:${Object.keys(fixture.aggregates[String(z)]).length}`).join(' ');
  console.log(`wrote ${path} — clusters per zoom: ${counts}`);
}

main();
