// Dual benchmark dataset generator.
//
// Produces two families of Point datasets, both as GeoJSON Feature arrays so
// they drop straight into supercluster's `load(points)`:
//
//   1. uniformRandom(n, seed) — uniform-random Points over
//      lng [-180, 180) / lat [-80, 80), matching refs/supercluster/bench.js.
//
//   2. clusteredSynthetic(n, seed, centers) — clustered-synthetic Points:
//      Natural Earth populated-places coordinates (the `centers` argument,
//      loaded from places.json) are sampling centers; Points are Gaussian-
//      sampled per city, population-weighted (scalerank as the population
//      proxy: lower scalerank => larger city => more Points).
//
// All generators are seeded and reproducible: the same (n, seed) pair yields a
// byte-identical dataset, so the benchmark baseline and the oracle are
// falsifiable and reproducible. `Math.random()` is deliberately avoided.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'places.json');

// --- Seeded PRNG -----------------------------------------------------------
//
// xorshift32: 4 bytes of state, full 2^32-1 period, no deps. Deterministic
// across machines and Node versions, unlike Math.random(). Returns a float
// in [0, 1).
function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9; // xorshift32 cannot start at 0
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

// Standard normal via Box-Muller, driven by a seeded rng.
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- uniformRandom ---------------------------------------------------------

/**
 * Generate `n` uniform-random GeoJSON Point features.
 *
 * Coordinates: lng in [-180, 180), lat in [-80, 80) — the same ranges as
 * refs/supercluster/bench.js. Each feature carries `properties.index` equal to
 * its position in the array, matching bench.js's `{index: i}` convention so the
 * oracle can recover source-point identity.
 *
 * @param {number} n
 * @param {number} seed  Any 32-bit integer; 0 is remapped internally.
 * @returns {Array<object>} GeoJSON Feature[].
 */
export function uniformRandom(n, seed) {
  const rng = createRng(seed);
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = {
      type: 'Feature',
      properties: { index: i },
      geometry: {
        type: 'Point',
        coordinates: [-180 + 360 * rng(), -80 + 160 * rng()],
      },
    };
  }
  return points;
}

// --- clusteredSynthetic ----------------------------------------------------

// Population weight per center. Natural Earth's `scalerank` is an inverse
// prominence proxy (1 = largest, 10 = smallest). We invert it so larger cities
// draw more Points, then normalize to a probability distribution.
function populationWeight(scalerank) {
  // Default prominence for centers missing a scalerank (e.g. null-property
  // features). Mid-range, so they neither dominate nor vanish.
  const rank = scalerank ?? 5;
  return 11 - rank;
}

/**
 * Generate `n` clustered-synthetic GeoJSON Point features.
 *
 * `centers` is an array of GeoJSON Point features (typically `loadPlaces()`).
 * For each emitted Point, a center is drawn population-weighted (scalerank as
 * the population proxy), then a Gaussian offset is added in degrees. The
 * longitudinal spread is wider than the latitudinal spread to reflect that
 * cities spread more along longitude at most latitudes; both are small enough
 * that Points concentrate around their center (the "clustered-realistic"
 * shape the spec calls for, as opposed to uniform-random).
 *
 * @param {number} n
 * @param {number} seed
 * @param {Array<object>} centers  GeoJSON Feature[] of sampling centers
 *   (typically `loadCenters()`).
 * @returns {Array<object>} GeoJSON Feature[].
 */
export function clusteredSynthetic(n, seed, centers) {
  // Skip centers without geometry (e.g. the fixture's "Null Island" feature
  // with geometry: null) — supercluster itself skips these on load, and we
  // cannot Gaussian-sample around a missing coordinate.
  const valid = centers.filter(f => f.geometry && f.geometry.coordinates);
  if (valid.length === 0) {
    throw new Error('clusteredSynthetic requires at least one center with geometry.');
  }
  const rng = createRng(seed);

  // Build a cumulative distribution over centers for population-weighted
  // sampling. O(centers) once, then O(log centers) per draw.
  const weights = valid.map(f => populationWeight(f.properties?.scalerank));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const cumulative = new Float64Array(valid.length);
  let acc = 0;
  for (let i = 0; i < valid.length; i++) {
    acc += weights[i] / totalWeight;
    cumulative[i] = acc;
  }
  cumulative[cumulative.length - 1] = 1; // guard against fp drift

  const pickCenter = () => {
    const r = rng();
    // binary search for the first cumulative entry >= r
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return valid[lo];
  };

  // Spread in degrees. ~1.5° longitude ≈ a large metro area; small enough
  // that Points cluster tightly around their city center.
  const LNG_SPREAD = 1.5;
  const LAT_SPREAD = 1.0;

  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const center = pickCenter();
    const [lng, lat] = center.geometry.coordinates;
    points[i] = {
      type: 'Feature',
      properties: { index: i },
      geometry: {
        type: 'Point',
        coordinates: [lng + gaussian(rng) * LNG_SPREAD, lat + gaussian(rng) * LAT_SPREAD],
      },
    };
  }
  return points;
}

// --- loadPlaces ------------------------------------------------------------

let cachedPlaces = null;

/**
 * Load the vendored `places.json` fixture (163 real geographic Points,
 * ISC-licensed © Mapbox, derived from the supercluster test fixtures). This is
 * the oracle seed corpus. Cached after first load. Returns the `features`
 * array, including the "Null Island" feature with `geometry: null`.
 *
 * @returns {Array<object>} GeoJSON Feature[].
 */
export function loadPlaces() {
  if (cachedPlaces) return cachedPlaces;
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const collection = JSON.parse(raw);
  cachedPlaces = collection.features;
  return cachedPlaces;
}

// --- loadCenters -----------------------------------------------------------

const CENTERS_PATH = join(__dirname, '..', 'fixtures', 'centers.json');
let cachedCenters = null;

/**
 * Load the vendored `centers.json` fixture: the 162 coordinate-bearing
 * features of `places.json` (the "Null Island" sentinel with `geometry: null`
 * is dropped). Used as the sampling-center corpus for `clusteredSynthetic`.
 *
 * The spec names "Natural Earth populated-places city coordinates" as the
 * intended center corpus; `centers.json` is a Natural Earth-derived stand-in
 * (capes/islands/waterfalls, not literally populated places). See
 * `bench/fixtures/NOTICE` for the recorded substitution. Cached after first
 * load.
 *
 * @returns {Array<object>} GeoJSON Feature[] (all with Point geometry).
 */
export function loadCenters() {
  if (cachedCenters) return cachedCenters;
  const raw = readFileSync(CENTERS_PATH, 'utf8');
  const collection = JSON.parse(raw);
  cachedCenters = collection.features;
  return cachedCenters;
}
