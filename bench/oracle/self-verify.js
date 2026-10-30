// Self-verify gate: proves the oracle machinery correct before any Rust
// version exists.
//
// A JS-vs-JS self-diff MUST return zero differences — same adapter, same
// options, same points. If it does not, the machinery is broken (or, as
// discovered during development, the reference implementation's shared
// scratch stack is being corrupted by concurrent test execution — which is
// why these assertions live in a serial describe block).
//
// This file is a node:test suite (run via `pnpm test`), NOT a benchmark.
// It is the cheap, fast gate. The expensive 1M/6M JS-vs-JS diff lives in
// oracle-1m.js and is run on demand, not in CI.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlaces, loadCenters, uniformRandom, clusteredSynthetic } from '../datasets/generate.js';
import { createSuperclusterAdapter } from './adapter-supercluster.js';
import { runOracle } from './oracle.js';
import { DEFAULT_OPTIONS, ALL_ZOOMS } from './config.js';

// Serial for the same reason as test/oracle.test.js: supercluster's shared
// kdbush scratch stack is not safe under concurrent execution.
describe('oracle self-verify (JS-vs-JS)', { concurrency: 1, sequential: true }, () => {

  test('places.json: JS-vs-JS self-diff is zero', () => {
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0, 'JS-vs-JS on places.json must be identical');
    assert.equal(result.pointCount, points.length);
  });

  test('seeded 1k uniform: JS-vs-JS self-diff is zero', () => {
    const adapter = createSuperclusterAdapter();
    const points = uniformRandom(1000, 42);
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0, 'JS-vs-JS on seeded uniform must be identical');
  });

  test('seeded 1k clustered: JS-vs-JS self-diff is zero', () => {
    const adapter = createSuperclusterAdapter();
    const centers = loadCenters();
    const points = clusteredSynthetic(1000, 42, centers);
    const result = runOracle(adapter, adapter, points, DEFAULT_OPTIONS, DEFAULT_OPTIONS, ALL_ZOOMS);
    assert.equal(result.totalDifferences, 0, 'JS-vs-JS on seeded clustered must be identical');
  });

  test('anti-tautology: different radius is detected as non-zero', () => {
    // The gate would be worthless if it always returned zero. Diffing two
    // genuinely different clusterings MUST surface differences.
    const adapter = createSuperclusterAdapter();
    const points = loadPlaces();
    const result = runOracle(
      adapter, adapter, points,
      { ...DEFAULT_OPTIONS, radius: 40 },
      { ...DEFAULT_OPTIONS, radius: 100 },
      ALL_ZOOMS,
    );
    assert.ok(result.totalDifferences > 0, 'different radius must be detected');
  });
});
