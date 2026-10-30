import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  uniformRandom,
  clusteredSynthetic,
  loadPlaces,
  loadCenters,
} from '../bench/datasets/generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// uniformRandom(n, seed)
// Replicates refs/supercluster/bench.js's uniform-random configuration:
//   lng in [-180, 180), lat in [-80, 80), feature.properties.index === i.
// ---------------------------------------------------------------------------

test('uniformRandom: produces n features', () => {
  const points = uniformRandom(1000, 42);
  assert.equal(points.length, 1000);
});

test('uniformRandom: is reproducible for a fixed seed', () => {
  const a = uniformRandom(500, 7);
  const b = uniformRandom(500, 7);
  assert.deepEqual(a, b);
});

test('uniformRandom: different seeds produce different data', () => {
  const a = uniformRandom(500, 1);
  const b = uniformRandom(500, 2);
  assert.notDeepEqual(a, b);
});

test('uniformRandom: coordinates stay in documented ranges', () => {
  const points = uniformRandom(5000, 3);
  for (const f of points) {
    const [lng, lat] = f.geometry.coordinates;
    assert.ok(lng >= -180 && lng < 180, `lng out of range: ${lng}`);
    assert.ok(lat >= -80 && lat < 80, `lat out of range: ${lat}`);
  }
});

test('uniformRandom: features are GeoJSON Points carrying their source index', () => {
  const points = uniformRandom(50, 9);
  for (let i = 0; i < points.length; i++) {
    assert.equal(points[i].type, 'Feature');
    assert.equal(points[i].geometry.type, 'Point');
    assert.equal(points[i].properties.index, i);
  }
});

// ---------------------------------------------------------------------------
// clusteredSynthetic(n, seed, centers)
// Natural Earth populated-places coordinates (from places.json) are used as
// sampling centers; Gaussian-sampled points per city, population-weighted
// (scalerank as the population proxy: lower scalerank => more points).
// ---------------------------------------------------------------------------

test('clusteredSynthetic: produces n features', () => {
  const centers = loadCenters();
  const points = clusteredSynthetic(2000, 42, centers);
  assert.equal(points.length, 2000);
});

test('clusteredSynthetic: is reproducible for a fixed seed', () => {
  const centers = loadCenters();
  const a = clusteredSynthetic(1000, 5, centers);
  const b = clusteredSynthetic(1000, 5, centers);
  assert.deepEqual(a, b);
});

test('clusteredSynthetic: actually clusters (std-dev of point positions is lower than uniform)', () => {
  // A clustered dataset concentrates points near city centers, so the mean
  // nearest-neighbor distance is much smaller than for a uniform spread.
  const centers = loadCenters();
  const clustered = clusteredSynthetic(2000, 11, centers);
  const uniform = uniformRandom(2000, 11);

  const meanNearestNeighbor = (pts) => {
    const coords = pts.map(f => f.geometry.coordinates);
    let total = 0;
    for (let i = 0; i < coords.length; i++) {
      let best = Infinity;
      for (let j = 0; j < coords.length; j++) {
        if (i === j) continue;
        const dx = coords[i][0] - coords[j][0];
        const dy = coords[i][1] - coords[j][1];
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      total += Math.sqrt(best);
    }
    return total / coords.length;
  };

  const clusteredNN = meanNearestNeighbor(clustered);
  const uniformNN = meanNearestNeighbor(uniform);
  // Clustering pulls points together, so nearest-neighbor distance shrinks.
  assert.ok(clusteredNN < uniformNN * 0.5,
    `expected clustered NN (${clusteredNN.toFixed(3)}) << uniform NN (${uniformNN.toFixed(3)})`);
});

test('clusteredSynthetic: features are GeoJSON Points carrying their source index', () => {
  const centers = loadCenters();
  const points = clusteredSynthetic(300, 13, centers);
  for (let i = 0; i < points.length; i++) {
    assert.equal(points[i].type, 'Feature');
    assert.equal(points[i].geometry.type, 'Point');
    assert.equal(points[i].properties.index, i);
  }
});

// ---------------------------------------------------------------------------
// loadPlaces()
// Loads the vendored places.json fixture (163 real geographic Points, ISC).
// ---------------------------------------------------------------------------

test('loadPlaces: returns 163 features from the fixture', () => {
  const places = loadPlaces();
  assert.equal(places.length, 163);
});

test('loadPlaces: every feature is a GeoJSON Point with geometry, except the Null Island sentinel', () => {
  // The upstream fixture contains a "Null Island" feature with geometry: null
  // (a real-world edge case supercluster skips on load via
  // `if (!p.geometry) continue;`). We surface that contract here rather than
  // papering over it.
  const places = loadPlaces();
  const noGeo = places.filter(f => !f.geometry);
  assert.equal(noGeo.length, 1, 'expected exactly one null-geometry feature');
  assert.equal(noGeo[0].properties.name, 'Null Island');
  for (const f of places) {
    assert.equal(f.type, 'Feature');
    if (!f.geometry) continue;
    assert.equal(f.geometry.type, 'Point');
    assert.equal(f.geometry.coordinates.length, 2);
  }
});

test('loadPlaces: reads from the vendored bench/fixtures/places.json', () => {
  // Indirect: the fixture's first feature is Niagara Falls.
  const places = loadPlaces();
  assert.equal(places[0].properties.name, 'Niagara Falls');
});

// ---------------------------------------------------------------------------
// loadCenters()
// Loads the vendored centers.json fixture: the 162 coordinate-bearing
// features of places.json (Null Island sentinel dropped). Used as the
// clustered-synthetic sampling-center corpus.
// ---------------------------------------------------------------------------

test('loadCenters: returns the 162 geometry-bearing features (places.json minus Null Island)', () => {
  const centers = loadCenters();
  assert.equal(centers.length, 162);
  // Every center must carry a Point geometry — that is the whole point of the
  // subset (clusteredSynthetic samples around these coordinates).
  for (const f of centers) {
    assert.ok(f.geometry, 'center must have geometry');
    assert.equal(f.geometry.type, 'Point');
  }
});

test('loadCenters: is a strict subset of loadPlaces (same features, null-geometry dropped)', () => {
  const places = loadPlaces();
  const centers = loadCenters();
  // Re-derive the subset the same way centers.json was built and compare.
  const expected = places.filter(f => f.geometry);
  assert.deepEqual(centers, expected);
});

