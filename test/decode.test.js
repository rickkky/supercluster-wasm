// Tier 3 (ticket 07): the JS decode helper.
//
// The WASM side writes the compact typed-array contract (encode.rs); this side
// decodes it back into GeoJSON Features. The boundary contract is "the typed
// array a WASM call returns decodes to the expected id+coord+count+cluster/
// point-tag set for a given query" — these tests assert that decode produces
// the expected Feature shapes from known typed-array inputs, without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeQueryResult,
  decodeHybridResult,
  abbreviateCount,
  ROW_STRIDE,
} from '../js/decode.js';

// Build a WASM-shaped result object from a list of row descriptors.
// Each descriptor: {lng, lat, id, numPoints, tag, agg?}. `specLen` is inferred
// from the agg arrays' length (all clusters share the same specLen).
function buildResult(rows, specLen = 0) {
  const rowBuf = new Float64Array(rows.length * ROW_STRIDE);
  const aggVals = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const b = i * ROW_STRIDE;
    rowBuf[b] = r.lng;
    rowBuf[b + 1] = r.lat;
    rowBuf[b + 2] = r.id;
    rowBuf[b + 3] = r.numPoints;
    rowBuf[b + 4] = r.tag;
    if (r.tag === 1.0 && specLen > 0) {
      const agg = r.agg || [];
      for (let j = 0; j < specLen; j++) aggVals.push(agg[j] ?? 0);
    }
  }
  return {
    count: rows.length,
    rows: rowBuf,
    aggregated: new Float64Array(aggVals),
    specLen,
  };
}

test('decodeQueryResult: empty result -> empty array', () => {
  const res = { count: 0, rows: new Float64Array(0), aggregated: new Float64Array(0), specLen: 0 };
  assert.deepEqual(decodeQueryResult(res, [], []), []);
});

test('decodeQueryResult: cluster row -> synthesized Feature with cluster props', () => {
  const res = buildResult([
    { lng: 13.4, lat: 52.5, id: 1000, numPoints: 42, tag: 1.0 },
  ], 0);
  const out = decodeQueryResult(res, [], []);
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.id, 1000);
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [13.4, 52.5] });
  assert.equal(f.properties.cluster, true);
  assert.equal(f.properties.cluster_id, 1000);
  assert.equal(f.properties.point_count, 42);
  assert.equal(f.properties.point_count_abbreviated, 42);
});

test('decodeQueryResult: point row -> recovers the original source feature by id', () => {
  // feature_id indexes the geometry-bearing subset.
  const sourceFeatures = [
    { type: 'Feature', id: 0, properties: { name: 'alpha' }, geometry: { type: 'Point', coordinates: [-79.04, 43.08] } },
    { type: 'Feature', id: 1, properties: { name: 'beta' }, geometry: { type: 'Point', coordinates: [10.0, 20.0] } },
  ];
  const res = buildResult([
    { lng: -79.04, lat: 43.08, id: 0, numPoints: 1, tag: 0.0 },
    { lng: 10.0, lat: 20.0, id: 1, numPoints: 1, tag: 0.0 },
  ], 0);
  const out = decodeQueryResult(res, sourceFeatures, []);
  assert.equal(out.length, 2);
  assert.equal(out[0], sourceFeatures[0], 'point 0 recovers the original source feature object');
  assert.equal(out[1], sourceFeatures[1], 'point 1 recovers the original source feature object');
});

test('decodeQueryResult: point_count_abbreviated matches supercluster formatting', () => {
  assert.equal(abbreviateCount(0), 0);
  assert.equal(abbreviateCount(999), 999);
  assert.equal(abbreviateCount(1000), '1k');
  assert.equal(abbreviateCount(1500), '1.5k');
  assert.equal(abbreviateCount(9999), '10k');
  assert.equal(abbreviateCount(10000), '10k');
  assert.equal(abbreviateCount(12345), '12k');
});

test('decodeQueryResult: cluster with spec attaches aggregated values by name', () => {
  const res = buildResult([
    { lng: 0, lat: 0, id: 5, numPoints: 10, tag: 1.0, agg: [25.0, 9.0] },
  ], 2);
  const out = decodeQueryResult(res, [], ['sum', 'max']);
  assert.equal(out.length, 1);
  const props = out[0].properties;
  assert.equal(props.sum, 25.0, 'first spec field "sum" attached');
  assert.equal(props.max, 9.0, 'second spec field "max" attached');
  // cluster props still present alongside aggregated values
  assert.equal(props.cluster, true);
  assert.equal(props.point_count, 10);
});

test('decodeQueryResult: mixed cluster/point sequence reads aggregated buffer cluster-dense', () => {
  // point, cluster, cluster, point — specLen 1. The aggregated buffer is
  // cluster-dense: only the two clusters contribute (one slot each), packed
  // contiguously; points contribute nothing.
  const sourceFeatures = [
    { type: 'Feature', id: 0, properties: { i: 0 }, geometry: { type: 'Point', coordinates: [-10, -20] } },
    { type: 'Feature', id: 1, properties: { i: 1 }, geometry: { type: 'Point', coordinates: [10, 20] } },
  ];
  const res = buildResult([
    { lng: -10, lat: -20, id: 0, numPoints: 1, tag: 0.0 },
    { lng: 1, lat: 2, id: 100, numPoints: 3, tag: 1.0, agg: [5.0] },
    { lng: 3, lat: 4, id: 101, numPoints: 4, tag: 1.0, agg: [7.0] },
    { lng: 10, lat: 20, id: 1, numPoints: 1, tag: 0.0 },
  ], 1);
  const out = decodeQueryResult(res, sourceFeatures, ['v']);
  assert.equal(out.length, 4);
  // row 0: point -> source 0
  assert.equal(out[0], sourceFeatures[0]);
  // row 1: cluster 100 with agg 5.0
  assert.equal(out[1].properties.cluster_id, 100);
  assert.equal(out[1].properties.v, 5.0);
  // row 2: cluster 101 with agg 7.0 (cluster-dense: agg offset advanced only here)
  assert.equal(out[2].properties.cluster_id, 101);
  assert.equal(out[2].properties.v, 7.0);
  // row 3: point -> source 1
  assert.equal(out[3], sourceFeatures[1]);
});

test('decodeQueryResult: missing source feature for a point falls back to a synthesized point', () => {
  // Defensive: a point whose feature_id has no source feature still decodes
  // to a Feature with the encoded lng/lat (should not happen in practice).
  const res = buildResult([
    { lng: 5, lat: 6, id: 7, numPoints: 1, tag: 0.0 },
  ], 0);
  const out = decodeQueryResult(res, [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'Feature');
  assert.deepEqual(out[0].geometry, { type: 'Point', coordinates: [5, 6] });
});

// ===========================================================================
// decodeHybridResult (ticket 10): the hybrid id+encoded decode.
//
// The ids fast path returns {point_ids: Uint32Array, cluster_rows: Float64Array,
// cluster_aggregated: Float64Array, count, specLen}: Point rows are source-
// feature ids only (the main thread indexes its own source features — zero
// per-row encode, zero JS object reconstruction), Cluster rows are encoded via
// the existing encoder (Clusters are synthesized inside WASM and have no source
// feature on the main thread, so their lng/lat/num_points/aggregated must cross
// encoded — unavoidable). The hybrid decode reuses the existing decodeQueryResult
// on the cluster-side buffers (cluster_rows + cluster_aggregated form a valid
// {rows, aggregated, count, specLen} result for the cluster rows), then pushes
// sourceFeatures[point_id] per Point row. The returned Feature[] must match
// getClusters's shape exactly — a drop-in replacement.
//
// These tests assert the hybrid decode produces the expected Feature shapes from
// known typed-array inputs, without a browser. They are the JS decode contract
// seam (the same seam as decodeQueryResult above, extended to the hybrid shape).
// ===========================================================================

// Build a hybrid result object from point ids + cluster row descriptors.
// `pointIds` is a number[] of source-feature ids; `clusters` is a list of
// {lng, lat, id, numPoints, agg?} (tag is always 1.0 for clusters). `specLen`
// is inferred from the agg arrays' length.
function buildHybridResult(pointIds, clusters, specLen = 0) {
  const point_ids = new Uint32Array(pointIds);
  const rowBuf = new Float64Array(clusters.length * ROW_STRIDE);
  const aggVals = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const b = i * ROW_STRIDE;
    rowBuf[b] = c.lng;
    rowBuf[b + 1] = c.lat;
    rowBuf[b + 2] = c.id;
    rowBuf[b + 3] = c.numPoints;
    rowBuf[b + 4] = 1.0; // tag = cluster
    if (specLen > 0) {
      const agg = c.agg || [];
      for (let j = 0; j < specLen; j++) aggVals.push(agg[j] ?? 0);
    }
  }
  return {
    point_ids,
    cluster_rows: rowBuf,
    cluster_aggregated: new Float64Array(aggVals),
    count: pointIds.length + clusters.length,
    specLen,
  };
}

test('decodeHybridResult: empty result -> empty array', () => {
  const res = {
    point_ids: new Uint32Array(0),
    cluster_rows: new Float64Array(0),
    cluster_aggregated: new Float64Array(0),
    count: 0,
    specLen: 0,
  };
  assert.deepEqual(decodeHybridResult(res, [], []), []);
});

test('decodeHybridResult: point ids -> source-feature reference pushes (zero alloc)', () => {
  // Point rows index the already-held source features by id — no object
  // reconstruction, the exact same object reference getClusters returns.
  const sourceFeatures = [
    { type: 'Feature', id: 0, properties: { name: 'alpha' }, geometry: { type: 'Point', coordinates: [-79.04, 43.08] } },
    { type: 'Feature', id: 1, properties: { name: 'beta' }, geometry: { type: 'Point', coordinates: [10.0, 20.0] } },
  ];
  const res = buildHybridResult([0, 1], [], 0);
  const out = decodeHybridResult(res, sourceFeatures, []);
  assert.equal(out.length, 2);
  assert.equal(out[0], sourceFeatures[0], 'point 0 is the original source feature object (reference push)');
  assert.equal(out[1], sourceFeatures[1], 'point 1 is the original source feature object (reference push)');
});

test('decodeHybridResult: cluster rows -> synthesized Features matching getClusters shape', () => {
  const res = buildHybridResult([], [
    { lng: 13.4, lat: 52.5, id: 1000, numPoints: 42 },
  ], 0);
  const out = decodeHybridResult(res, [], []);
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.id, 1000);
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [13.4, 52.5] });
  assert.equal(f.properties.cluster, true);
  assert.equal(f.properties.cluster_id, 1000);
  assert.equal(f.properties.point_count, 42);
  assert.equal(f.properties.point_count_abbreviated, 42);
});

test('decodeHybridResult: cluster with spec attaches aggregated values by name', () => {
  const res = buildHybridResult([], [
    { lng: 0, lat: 0, id: 5, numPoints: 10, agg: [25.0, 9.0] },
  ], 2);
  const out = decodeHybridResult(res, [], ['sum', 'max']);
  assert.equal(out.length, 1);
  const props = out[0].properties;
  assert.equal(props.sum, 25.0, 'first spec field "sum" attached');
  assert.equal(props.max, 9.0, 'second spec field "max" attached');
  assert.equal(props.cluster, true);
  assert.equal(props.point_count, 10);
});

test('decodeHybridResult: points-then-clusters order matches getClusters drop-in shape', () => {
  // The hybrid result carries points and clusters in separate buffers; the
  // decode must emit them in the same relative order getClusters would (points
  // from point_ids in order, then clusters from cluster_rows in order) so the
  // returned Feature[] is a drop-in for getClusters's output.
  const sourceFeatures = [
    { type: 'Feature', id: 0, properties: { i: 0 }, geometry: { type: 'Point', coordinates: [-10, -20] } },
    { type: 'Feature', id: 1, properties: { i: 1 }, geometry: { type: 'Point', coordinates: [10, 20] } },
  ];
  const res = buildHybridResult(
    [0, 1],
    [
      { lng: 1, lat: 2, id: 100, numPoints: 3, agg: [5.0] },
      { lng: 3, lat: 4, id: 101, numPoints: 4, agg: [7.0] },
    ],
    1,
  );
  const out = decodeHybridResult(res, sourceFeatures, ['v']);
  assert.equal(out.length, 4);
  // Points first (reference pushes), then clusters (synthesized).
  assert.equal(out[0], sourceFeatures[0]);
  assert.equal(out[1], sourceFeatures[1]);
  assert.equal(out[2].properties.cluster_id, 100);
  assert.equal(out[2].properties.v, 5.0);
  assert.equal(out[3].properties.cluster_id, 101);
  assert.equal(out[3].properties.v, 7.0);
});

test('decodeHybridResult: missing source feature for a point id falls back to a synthesized point', () => {
  // Defensive: a point_id with no source feature still decodes to a Feature.
  // The ids path carries no lng/lat for points, so the fallback synthesizes a
  // null-geometry point (the caller holds no coordinate for an unknown id).
  const res = buildHybridResult([7], [], 0);
  const out = decodeHybridResult(res, [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'Feature');
  assert.equal(out[0].id, 7);
});
