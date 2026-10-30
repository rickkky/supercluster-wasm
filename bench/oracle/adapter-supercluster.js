// Oracle adapter for the JavaScript `supercluster` reference implementation.
//
// The oracle compares cluster *membership* per zoom — which source Points end
// up in the same Cluster at a given Zoom Level — not cluster ids (which the
// spec explicitly says need not match). An adapter is the seam that lets the
// oracle talk to any clustering implementation exposing the same surface:
//
//   buildSpatialIndex(points, options) -> spatialIndex
//   extractClusterLattice(spatialIndex, zoom) -> Array<ClusterMembership>
//
// where a ClusterMembership is a sorted array of source-point array indices
// (the Points that belong to one Cluster at that zoom). Array-index identity
// is the canonical source-point id: it works for places.json (whose features
// carry no stable id) and for generated datasets alike.
//
// To recover source-point identity from a Cluster's leaves, each input Point
// is tagged with `__oracleId` (its array position) before build. The adapter
// reads that tag back off the leaves supercluster returns. This is the only
// piece of adapter machinery that touches Point internals; everything else is
// the public supercluster API.

import Supercluster from 'supercluster';

const ORACLE_ID = '__oracleId';

/**
 * Create an oracle adapter around the JS supercluster reference implementation.
 */
export function createSuperclusterAdapter() {
  return {
    /**
     * Build a Spatial Index from `points`.
     *
     * Each input Point is tagged with `__oracleId` (its array index) so a
     * Cluster's leaves can be mapped back to source-point identity. The tag
     * is written onto a shallow clone of each feature's properties so the
     * caller's input array is not mutated.
     *
     * @param {Array<object>} points  GeoJSON Feature[].
     * @param {object} options       supercluster options (radius/extent/...).
     * @returns {object} spatialIndex  The built index plus the tagged points.
     */
    buildSpatialIndex(points, options) {
      // `reduce: null` is supercluster's default; we never run a reducer.
      const tagged = points.map((f, i) => {
        // Preserve null-property features (supercluster handles them) by
        // creating a fresh properties object only when needed.
        const props = f.properties == null ? {} : { ...f.properties };
        props[ORACLE_ID] = i;
        return { ...f, properties: props };
      });
      const index = new Supercluster({ reduce: null, ...options }).load(tagged);
      return { index, points: tagged, count: tagged.length };
    },

    /**
     * Extract the full Cluster Lattice at `zoom`: every top-level Cluster and
     * unclustered Point, as a list of source-point-id memberships.
     *
     * Queries the whole-world bbox so the result is the complete Cluster
     * Lattice, not a viewport slice. For each returned feature:
     *   - a singleton point -> a one-element membership [its source id];
     *   - a Cluster -> enumerate its leaves via getLeaves and collect their
     *     source ids.
     *
     * Each membership is sorted ascending and deduped. Memberships with no
     * recoverable source ids are dropped (should not happen for tagged input).
     *
     * Note: supercluster skips input Points with `geometry: null` on load, so
     * such Points never appear in any Cluster Lattice. The oracle's membership
     * therefore covers only the geometry-bearing subset of the input; both
     * sides of a self-diff drop the same Points, so the gate still holds, but
     * the source-set coverage is the geometry-bearing count, not the raw input
     * count.
     *
     * @param {object} spatialIndex  The {index, points, count} from buildSpatialIndex.
     * @param {number} zoom
     * @returns {Array<Array<number>>}  Cluster memberships (source-point ids).
     */
    extractClusterLattice(spatialIndex, zoom) {
      const { index } = spatialIndex;
      const features = index.getClusters([-180, -90, 180, 90], zoom);
      const memberships = [];
      for (const f of features) {
        const props = f.properties || {};
        if (props.cluster) {
          // Enumerate all leaves of this Cluster. getLeaves paginates; fetch
          // in a loop until we have them all. supercluster's
          // getLeaves(clusterId, limit, offset) returns up to `limit` leaves
          // starting at offset.
          const clusterId = props.cluster_id;
          const ids = [];
          const pageSize = 1000;
          let offset = 0;
          let batch;
          do {
            batch = index.getLeaves(clusterId, pageSize, offset);
            for (const leaf of batch) {
              const id = leaf?.properties?.[ORACLE_ID];
              if (id !== undefined) ids.push(id);
            }
            offset += batch.length;
          } while (batch.length === pageSize);
          if (ids.length) memberships.push(sortDedupe(ids));
        } else {
          const id = props[ORACLE_ID];
          if (id !== undefined) memberships.push([id]);
        }
      }
      return memberships;
    },
  };
}

function sortDedupe(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (out[out.length - 1] !== v) out.push(v);
  return out;
}
