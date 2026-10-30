// Tier 3 (ticket 07): decode the compact typed-array result contract back
// into GeoJSON Features.
//
// The WASM side (crates/supercluster/src/encode.rs) writes two Float64Arrays:
//   rows       — stride 5: [lng, lat, id, num_points, tag]
//                 tag = 0.0 = unclustered Point | 1.0 = Cluster
//   aggregated — stride specLen: finalized values in spec order, cluster-dense
//                 (only cluster rows contribute; points carry none)
// plus a `count` (number of rows) and `specLen`.
//
// This mirrors refs/supercluster/index.js's getClusterJSON/getClusterProperties:
// clusters synthesize {type:'Feature', id, properties:{cluster:true, cluster_id,
// point_count, point_count_abbreviated, ...aggregated}, geometry:{Point,[lng,lat]}};
// points recover the original source feature (indexed by feature_id, which is the
// geometry-bearing subset — see query.rs FeatureKind::Point — so `sourceFeatures`
// must be `features.filter(f => f.geometry)`, preserving that order).

const ROW_STRIDE = 5;
const TAG_POINT = 0.0;
const TAG_CLUSTER = 1.0;

// Abbreviate a cluster's point count the way supercluster does
// (refs/supercluster/index.js getClusterProperties): >=10000 -> "Nk",
// >=1000 -> "N.Mk", else the raw count.
function abbreviateCount(count) {
  if (count >= 10000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`;
  return count;
}

// Decode a WASM query result into an array of GeoJSON Features.
//
//   res            — {count, rows: Float64Array, aggregated: Float64Array, specLen}
//   sourceFeatures — the geometry-bearing subset of the loaded features, indexed
//                    by feature_id (i.e. features.filter(f => f.geometry))
//   specFieldNames — the AggregationSpec field names, in spec order; attached to
//                    cluster properties under those names. Defaults to [].
//
// Returns [] when count == 0. Points recover `sourceFeatures[id]`; clusters
// synthesize a Feature. The aggregated buffer is read in lockstep with the row
// buffer, advancing the agg offset only on cluster rows (cluster-dense packing).
export function decodeQueryResult(res, sourceFeatures, specFieldNames = []) {
  const count = res.count | 0;
  if (count === 0) return [];

  const rows = res.rows;
  const aggregated = res.aggregated;
  const names = specFieldNames;
  const out = [];
  let aggOff = 0;

  for (let i = 0; i < count; i++) {
    const base = i * ROW_STRIDE;
    const lng = rows[base];
    const lat = rows[base + 1];
    const id = rows[base + 2];
    const numPoints = rows[base + 3];
    const tag = rows[base + 4];

    if (tag === TAG_CLUSTER) {
      const properties = {
        cluster: true,
        cluster_id: id,
        point_count: numPoints,
        point_count_abbreviated: abbreviateCount(numPoints),
      };
      // Attach aggregated values in spec order. The aggregated buffer is
      // cluster-dense: each cluster row contributes specLen contiguous values.
      for (let j = 0; j < names.length; j++) {
        properties[names[j]] = aggregated[aggOff + j];
      }
      aggOff += names.length;

      out.push({
        type: 'Feature',
        id,
        properties,
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    } else if (tag === TAG_POINT) {
      // Points recover the original source feature by feature_id. feature_id
      // indexes the geometry-bearing subset; a missing source is a defensive
      // fallback to a synthesized point (should not happen in practice).
      const src = sourceFeatures && sourceFeatures[id];
      if (src !== undefined) {
        out.push(src);
      } else {
        out.push({
          type: 'Feature',
          id,
          properties: {},
          geometry: { type: 'Point', coordinates: [lng, lat] },
        });
      }
    }
    // Any other tag is ignored (forward-compat).
  }

  return out;
}

// Decode a hybrid id+encoded result into an array of GeoJSON Features.
//
// The ids fast path (ticket 10) returns a hybrid shape: Point rows as a compact
// `Uint32Array` of source-feature ids (the main thread indexes its own already-
// held source features by id — zero per-row encode, zero JS object reconstruction),
// and Cluster rows as an encoded `Float64Array` pair (Clusters are synthesized
// inside WASM and have no source feature on the main thread, so their
// lng/lat/num_points/aggregated must still cross encoded — unavoidable). The
// returned `Feature[]` matches `getClusters`'s shape exactly — a drop-in
// replacement for the encoded path.
//
//   res            — {point_ids: Uint32Array, cluster_rows: Float64Array,
//                    cluster_aggregated: Float64Array, count, specLen}
//                    `cluster_rows`/`cluster_aggregated` are the encoded-path
//                    buffers for the cluster rows only (cluster-dense packing
//                    for `cluster_aggregated`, same as `decodeQueryResult`).
//   sourceFeatures — the geometry-bearing subset of the loaded features, indexed
//                    by point_id (i.e. features.filter(f => f.geometry))
//   specFieldNames — the AggregationSpec field names, in spec order.
//
// Point rows push `sourceFeatures[id]` (zero allocation, reference push); a
// missing source falls back to a null-geometry Feature (the ids path carries no
// coordinate for an unknown id). Cluster rows reuse `decodeQueryResult` on the
// cluster-side buffers — the cluster rows are a valid encoded result of their
// own, so the existing decode path produces identical Features. Points are
// emitted first (in `point_ids` order), then clusters (in `cluster_rows` order),
// matching the relative order the encoded `getClusters` path emits them.
export function decodeHybridResult(res, sourceFeatures, specFieldNames = []) {
  const count = res.count | 0;
  if (count === 0) return [];

  const pointIds = res.point_ids;
  const out = [];

  // Point rows: index the already-held source features by id. Zero allocation
  // — the exact same object reference getClusters returns for a Point row.
  for (let i = 0; i < pointIds.length; i++) {
    const id = pointIds[i];
    const src = sourceFeatures && sourceFeatures[id];
    if (src !== undefined) {
      out.push(src);
    } else {
      // Defensive: an id with no source feature. The ids path carries no
      // lng/lat for points, so synthesize a null-geometry Feature (should not
      // happen in practice — the main thread holds every source feature).
      out.push({ type: 'Feature', id, properties: {}, geometry: null });
    }
  }

  // Cluster rows: the cluster-side buffers are a valid encoded result of their
  // own (cluster_rows = stride-5 rows, cluster_aggregated = cluster-dense
  // values). Reuse the existing decode path — identical Feature shapes.
  const clusterCount = (res.cluster_rows.length / ROW_STRIDE) | 0;
  if (clusterCount > 0) {
    const clusters = decodeQueryResult(
      {
        count: clusterCount,
        rows: res.cluster_rows,
        aggregated: res.cluster_aggregated,
        specLen: res.specLen,
      },
      sourceFeatures,
      specFieldNames,
    );
    for (const f of clusters) out.push(f);
  }

  return out;
}

// Exported for tests.
export { ROW_STRIDE, TAG_POINT, TAG_CLUSTER, abbreviateCount };
