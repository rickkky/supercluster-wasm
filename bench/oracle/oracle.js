// Semantic-equivalence oracle.
//
// The oracle defines "correct" as identical Cluster membership per Zoom Level
// — the same source Points grouped into the same Clusters at every zoom —
// independent of cluster id values (which the spec says need not match). It is
// the single highest testing seam: feed identical inputs to two
// implementations, assert membership is identical. Black-box across the whole
// stack.
//
// Three pieces:
//   extractMembership(adapter, spatialIndex, zooms)
//     -> Map<zoom, Array<ClusterMembership>>  where ClusterMembership = number[]
//   diffMemberships(membershipA, membershipB, zooms)
//     -> { differences, totalDifferences }
//   runOracle(adapterA, adapterB, points, optionsA, optionsB, zooms)
//     -> end-to-end diff result
//
// A self-diff (same adapter, same options) MUST return zero differences — that
// is the machinery-proof gate. A diff across genuinely different clusterings
// (e.g. different radius) MUST return non-zero — that is the anti-tautology
// guard making the oracle falsifiable.

/**
 * Extract Cluster membership per Zoom Level from a built Spatial Index.
 *
 * @param {object} adapter        An adapter with `extractClusterLattice(spatialIndex, zoom)`.
 * @param {object} spatialIndex  The value returned by `adapter.buildSpatialIndex(...)`.
 * @param {Array<number>} zooms
 * @returns {Map<number, Array<Array<number>>>} Map zoom -> Cluster memberships.
 */
export function extractMembership(adapter, spatialIndex, zooms) {
  const membership = new Map();
  for (const z of zooms) {
    membership.set(z, adapter.extractClusterLattice(spatialIndex, z));
  }
  return membership;
}

/**
 * Canonicalize a Cluster membership (sorted source-id array) to a string key
 * for multiset comparison. Source ids are non-negative integers; joining with
 * a separator that cannot appear inside an integer keeps the key unambiguous.
 */
function membershipKey(membership) {
  return membership.join(',');
}

/**
 * Diff two memberships across the given zooms.
 *
 * Two memberships agree at a zoom iff the multiset of Cluster memberships is
 * identical — i.e. every membership in A has an equal membership in B and vice
 * versa. Equality of memberships is element-wise (same source-point ids, same
 * order after sorting).
 *
 * @param {Map<number, Array<Array<number>>>} a
 * @param {Map<number, Array<Array<number>>>} b
 * @param {Array<number>} zooms
 * @returns {{differences: Array, totalDifferences: number}}
 */
export function diffMemberships(a, b, zooms) {
  const differences = [];
  for (const z of zooms) {
    const membershipsA = a.get(z) ?? [];
    const membershipsB = b.get(z) ?? [];

    // Multiset comparison via canonical keys + counts.
    const keysA = new Map(); // key -> count
    for (const m of membershipsA) {
      const k = membershipKey(m);
      keysA.set(k, (keysA.get(k) ?? 0) + 1);
    }
    const keysB = new Map();
    for (const m of membershipsB) {
      const k = membershipKey(m);
      keysB.set(k, (keysB.get(k) ?? 0) + 1);
    }

    const onlyInA = [];
    const onlyInB = [];
    for (const [k, ca] of keysA) {
      const cb = keysB.get(k) ?? 0;
      if (ca > cb) onlyInA.push({ membership: k.split(',').map(Number), count: ca - cb });
    }
    for (const [k, cb] of keysB) {
      const ca = keysA.get(k) ?? 0;
      if (cb > ca) onlyInB.push({ membership: k.split(',').map(Number), count: cb - ca });
    }

    if (onlyInA.length || onlyInB.length) {
      differences.push({ zoom: z, onlyInA, onlyInB });
    }
  }
  const totalDifferences = differences.reduce((sum, d) => sum + d.onlyInA.length + d.onlyInB.length, 0);
  return { differences, totalDifferences };
}

/**
 * Run the oracle end-to-end: build two Spatial Indexes and diff their
 * Cluster memberships.
 *
 * @param {object} adapterA
 * @param {object} adapterB
 * @param {Array<object>} points
 * @param {object} optionsA
 * @param {object} [optionsB]  Defaults to optionsA (self-diff).
 * @param {Array<number>} [zooms]  Defaults to [0..6].
 * @returns {{differences: Array, totalDifferences: number, pointCount: number, zooms: Array<number>}}
 */
export function runOracle(adapterA, adapterB, points, optionsA, optionsB = optionsA, zooms = [0, 1, 2, 3, 4, 5, 6]) {
  const spatialIndexA = adapterA.buildSpatialIndex(points, optionsA);
  const spatialIndexB = adapterB.buildSpatialIndex(points, optionsB);
  const mA = extractMembership(adapterA, spatialIndexA, zooms);
  const mB = extractMembership(adapterB, spatialIndexB, zooms);
  const diff = diffMemberships(mA, mB, zooms);
  return { ...diff, pointCount: points.length, zooms };
}
