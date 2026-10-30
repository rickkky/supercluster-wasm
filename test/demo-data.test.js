// Tier 3 tests for the demo dataset generator (ticket 13).
//
// The generator is the demo's only unit-testable pure logic — the map UI is
// browser-verified. These tests pin the invariants the demo relies on:
// reproducibility (seeded), output shape (both GeoJSON + flat-coords
// variants), value properties for the Aggregation Spec, and coordinate
// sanity (lng/lat in range).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateClusteredGeoJSON,
  generateClusteredCoords,
  CITY_CENTERS,
  LNG_SPREAD,
  LAT_SPREAD,
} from '../demo/data.js';

test('generateClusteredGeoJSON: returns n GeoJSON Point features with value properties', () => {
  const points = generateClusteredGeoJSON(1000, 42);
  assert.equal(points.length, 1000);
  for (const p of points) {
    assert.equal(p.type, 'Feature');
    assert.equal(p.geometry.type, 'Point');
    const [lng, lat] = p.geometry.coordinates;
    assert.ok(lng >= -180 && lng <= 180, `lng ${lng} out of range`);
    assert.ok(lat >= -90 && lat <= 90, `lat ${lat} out of range`);
    assert.equal(typeof p.properties.value, 'number');
    assert.ok(p.properties.value > 0, 'value must be positive (sum aggregate)');
  }
});

test('generateClusteredGeoJSON: seeded — same seed, byte-identical output', () => {
  const a = generateClusteredGeoJSON(500, 7);
  const b = generateClusteredGeoJSON(500, 7);
  assert.deepEqual(a, b);
});

test('generateClusteredGeoJSON: clustered shape — points concentrate near centers', () => {
  // With 1k points over ~140 centers, most points should be within a few
  // degrees of SOME center (the clustered-realistic shape). Sample the first
  // 100 and check each has a center within 5 degrees.
  const points = generateClusteredGeoJSON(100, 3);
  for (const p of points) {
    const [lng, lat] = p.geometry.coordinates;
    const minDist = CITY_CENTERS.reduce((min, c) => {
      const d = Math.max(Math.abs(lng - c.lng), Math.abs(lat - c.lat));
      return d < min ? d : min;
    }, Infinity);
    assert.ok(minDist < 5, `point [${lng}, ${lat}] is ${minDist.toFixed(2)}° from the nearest center`);
  }
});

test('generateClusteredCoords: returns an even-length Float64Array of [lng, lat, ...] pairs', () => {
  const { coords } = generateClusteredCoords(1000, 42);
  assert.ok(coords instanceof Float64Array);
  assert.equal(coords.length, 2000);
  for (let i = 0; i < coords.length; i += 2) {
    assert.ok(coords[i] >= -180 && coords[i] <= 180, `lng ${coords[i]} out of range`);
    assert.ok(coords[i + 1] >= -90 && coords[i + 1] <= 90, `lat ${coords[i + 1]} out of range`);
  }
});

test('generateClusteredCoords: same seed as the GeoJSON variant yields the same coordinates', () => {
  // The two variants must be coordinate-identical for the same seed, so the
  // build-path toggle compares like with like (same dataset, different input
  // shape).
  const n = 400;
  const geo = generateClusteredGeoJSON(n, 42);
  const { coords } = generateClusteredCoords(n, 42);
  for (let i = 0; i < n; i++) {
    assert.equal(coords[i * 2], geo[i].geometry.coordinates[0]);
    assert.equal(coords[i * 2 + 1], geo[i].geometry.coordinates[1]);
  }
});

test('generateClusteredCoords: props table is index-aligned with the coords pairs', () => {
  // The load_coords join contract (Q8): props[i] describes the point at
  // coords[2i..2i+1] — same rng stream, same loop. The point must sit within
  // the recorded center's spread (a few sigma; NOT the geometric nearest
  // center — adjacent cities like Suzhou/Wuxi can be closer after scatter,
  // but props.city records the drawn center). value is the haversine
  // distance to that center in meters; pid is the index itself.
  const n = 200;
  const { coords, props } = generateClusteredCoords(n, 42);
  const byName = new Map(CITY_CENTERS.map((c) => [c.name, c]));
  assert.equal(props.length, n);
  for (let i = 0; i < n; i++) {
    const p = props[i];
    assert.equal(p.pid, i);
    assert.ok(typeof p.value === 'number' && p.value > 0);
    const c = byName.get(p.city);
    assert.ok(c, `props[${i}].city "${p.city}" must be a known center`);
    const [lng, lat] = [coords[i * 2], coords[i * 2 + 1]];
    assert.ok(
      Math.abs(lng - c.lng) <= 5 * LNG_SPREAD && Math.abs(lat - c.lat) <= 5 * LAT_SPREAD,
      `props[${i}] point [${lng}, ${lat}] too far from ${p.city} [${c.lng}, ${c.lat}]`,
    );
  }
});

test('CITY_CENTERS: non-empty, {name, lng, lat} in range', () => {
  assert.ok(CITY_CENTERS.length >= 100, 'expected the major-city center corpus');
  for (const c of CITY_CENTERS) {
    assert.equal(typeof c.name, 'string', 'each center carries a city name');
    assert.ok(c.lng >= -180 && c.lng <= 180);
    assert.ok(c.lat >= -90 && c.lat <= 90);
  }
});

test('generateClusteredGeoJSON: per-point properties {pid, city, value}', () => {
  // The click-to-inspect interaction reads these off the decoded source
  // feature (the query decode returns the original feature for points).
  // value is the point's distance to its seed center in meters.
  const points = generateClusteredGeoJSON(50, 11);
  const cityNames = new Set(CITY_CENTERS.map((c) => c.name));
  for (let i = 0; i < points.length; i++) {
    const props = points[i].properties;
    assert.equal(props.pid, i, 'pid is the point index');
    assert.ok(cityNames.has(props.city), `city "${props.city}" must be a known center`);
    assert.ok(typeof props.value === 'number' && props.value > 0);
  }
});
