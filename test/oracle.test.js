import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlaces, loadCenters, uniformRandom, clusteredSynthetic } from '../bench/datasets/generate.js';
import { createSuperclusterAdapter } from '../bench/oracle/adapter-supercluster.js';
import { extractMembership, diffMemberships, runOracle } from '../bench/oracle/oracle.js';
import { DEFAULT_OPTIONS, ALL_ZOOMS } from '../bench/oracle/config.js';

// The JS supercluster reference implementation (via kdbush) uses a single
// module-level scratch stack for its iterative-DFS range/within queries. Two
// Supercluster operations running concurrently on the same event loop corrupt
// that shared stack and produce non-deterministic clusters. node:test runs
// top-level tests concurrently by default, so the oracle tests must run
// serially: each runOracle call drives supercluster's full build+query path,
// and interleaving two of them is a reference-implementation hazard, not an
// oracle bug. The serial describe block below enforces that.
describe('oracle', { concurrency: 1, sequential: true }, () => {

  // -------------------------------------------------------------------------
  // extractMembership: partition property
  //
  // At each zoom, the union of all memberships must be exactly the
  // geometry-bearing source Points with no duplicates and no gaps — every such
  // Point belongs to exactly one top-level Cluster-or-Point. supercluster
  // skips null-geometry Points on load, so the partition covers the
  // geometry-bearing subset, not the raw input.
  // -------------------------------------------------------------------------

  test('extractMembership: returns a Map keyed by zoom', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(500, 1);
    const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
    const m = extractMembership(adapter, spatialIndex, [0, 1, 2]);
    assert.equal(m.size, 3);
    assert.ok(m.has(0) && m.has(1) && m.has(2));
  });

  test('extractMembership: memberships partition the geometry-bearing source Points at every zoom (uniform)', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(2000, 2);
    const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
    const m = extractMembership(adapter, spatialIndex, ALL_ZOOMS);
    for (const z of ALL_ZOOMS) {
      const memberships = m.get(z);
      const seen = new Set();
      let total = 0;
      for (const membership of memberships) {
        for (const id of membership) {
          assert.ok(!seen.has(id), `zoom ${z}: point ${id} appears in two clusters`);
          seen.add(id);
          total++;
        }
      }
      assert.equal(total, points.length, `zoom ${z}: expected ${points.length} points across clusters, got ${total}`);
    }
  });

  test('extractMembership: memberships partition places.json minus its null-geometry sentinel', () => {
    // places.json has one feature with geometry: null (Null Island), which
    // supercluster skips on load. The partition must therefore cover exactly
    // the 162 geometry-bearing features, not all 163.
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const geometryBearing = points.filter(f => f.geometry).length;
    const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
    const m = extractMembership(adapter, spatialIndex, ALL_ZOOMS);
    for (const z of ALL_ZOOMS) {
      const memberships = m.get(z);
      let total = 0;
      const seen = new Set();
      for (const membership of memberships) {
        for (const id of membership) {
          assert.ok(!seen.has(id), `zoom ${z}: point ${id} appears in two clusters`);
          seen.add(id);
          total++;
        }
      }
      assert.equal(total, geometryBearing, `zoom ${z}: expected ${geometryBearing} geometry-bearing points, got ${total}`);
    }
  });

  test('extractMembership: each membership is sorted and non-empty', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(500, 3);
    const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
    const m = extractMembership(adapter, spatialIndex, [0, 3, 6]);
    for (const memberships of m.values()) {
      for (const membership of memberships) {
        assert.ok(membership.length > 0, 'no empty clusters');
        for (let i = 1; i < membership.length; i++) {
          assert.ok(membership[i - 1] < membership[i], 'membership must be sorted ascending');
        }
      }
    }
  });

  test('extractMembership: maxZoom+1 is all singletons', () => {
    // At maxZoom+1 supercluster stores raw points (no clustering), so every
    // Cluster membership is a singleton. This is the trivial baseline the
    // oracle can lean on.
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(300, 4);
    const maxZoom = 6;
    const spatialIndex = adapter.buildSpatialIndex(points, { maxZoom });
    const m = extractMembership(adapter, spatialIndex, [maxZoom + 1]);
    const memberships = m.get(maxZoom + 1);
    assert.equal(memberships.length, points.length);
    for (const membership of memberships) assert.equal(membership.length, 1);
  });

  // -------------------------------------------------------------------------
  // diffMemberships: self-diff is zero (machinery proven correct)
  // -------------------------------------------------------------------------

  test('diffMemberships: self-diff returns zero differences', () => {
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const spatialIndex = adapter.buildSpatialIndex(points, DEFAULT_OPTIONS);
    const m = extractMembership(adapter, spatialIndex, ALL_ZOOMS);
    const diff = diffMemberships(m, m, ALL_ZOOMS);
    assert.equal(diff.differences.length, 0);
    assert.equal(diff.totalDifferences, 0);
  });

  // -------------------------------------------------------------------------
  // diffMemberships: anti-tautology guard
  //
  // If the oracle always returned zero, it would be tautological and useless.
  // Diffing two genuinely different clusterings (same points, different radius)
  // MUST produce non-zero differences. This is the assertion that makes the
  // oracle falsifiable.
  // -------------------------------------------------------------------------

  test('diffMemberships: different radius produces non-zero differences (anti-tautology)', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(2000, 5);

    const spatialIndexA = adapter.buildSpatialIndex(points, { ...DEFAULT_OPTIONS, radius: 40 });
    const spatialIndexB = adapter.buildSpatialIndex(points, { ...DEFAULT_OPTIONS, radius: 100 });

    const mA = extractMembership(adapter, spatialIndexA, ALL_ZOOMS);
    const mB = extractMembership(adapter, spatialIndexB, ALL_ZOOMS);
    const diff = diffMemberships(mA, mB, ALL_ZOOMS);

    assert.ok(diff.totalDifferences > 0, 'different radius must yield non-zero diff');
    assert.ok(diff.differences.length > 0, 'diff must list the differing zooms');
  });

  test('diffMemberships: reports the differing Point sets, not just a count', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(1000, 6);
    const spatialIndexA = adapter.buildSpatialIndex(points, { ...DEFAULT_OPTIONS, radius: 40 });
    const spatialIndexB = adapter.buildSpatialIndex(points, { ...DEFAULT_OPTIONS, radius: 100 });
    const zooms = [0, 1, 2];
    const mA = extractMembership(adapter, spatialIndexA, zooms);
    const mB = extractMembership(adapter, spatialIndexB, zooms);
    const diff = diffMemberships(mA, mB, zooms);

    // Each difference names a zoom and carries the memberships present in only
    // one side, as arrays of source-point ids — not just a numeric count.
    assert.ok(diff.differences.length > 0, 'expected at least one differing zoom');
    for (const d of diff.differences) {
      assert.ok(d.zoom !== undefined, 'difference must name the zoom');
      assert.ok(Array.isArray(d.onlyInA) || Array.isArray(d.onlyInB));
      for (const entry of d.onlyInA) {
        assert.ok(Array.isArray(entry.membership), 'onlyInA entry must carry a membership of point ids');
      }
      for (const entry of d.onlyInB) {
        assert.ok(Array.isArray(entry.membership), 'onlyInB entry must carry a membership of point ids');
      }
    }
  });

  // -------------------------------------------------------------------------
  // runOracle: end-to-end
  // -------------------------------------------------------------------------

  test('runOracle: JS-vs-JS self-diff on places.json returns zero (machinery proven)', () => {
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0);
    assert.equal(result.differences.length, 0);
    assert.equal(result.pointCount, points.length);
  });

  test('runOracle: JS-vs-JS self-diff on a seeded clustered set returns zero', () => {
    const adapter = createSuperclusterAdapter();
    const centers = loadCenters();
    const points = clusteredSynthetic(1000, 42, centers);
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0);
  });

  test('runOracle: JS-vs-JS self-diff on a seeded uniform set returns zero', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(1000, 42);
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0);
  });

  test('runOracle: JS-vs-JS with different radius reports non-zero differences', () => {
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const result = runOracle(
      adapter, adapter, points,
      { ...DEFAULT_OPTIONS, radius: 40 },
      { ...DEFAULT_OPTIONS, radius: 100 },
      ALL_ZOOMS,
    );
    assert.ok(result.totalDifferences > 0);
  });

});
