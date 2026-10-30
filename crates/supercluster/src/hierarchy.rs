//! Cluster Hierarchy drill-down (ticket 05): `get_children`, `get_leaves`,
//! and `get_cluster_expansion_zoom`.
//!
//! A direct port of `refs/supercluster/index.js`'s `getChildren` (lines
//! 115-141), `getLeaves`/`_appendLeaves` (lines 143-151, 194-220), and
//! `getClusterExpansionZoom` (lines 183-192). The algorithms are preserved
//! verbatim — the radius-at-origin-zoom convention, the `within` scan for
//! children (in kd-tree traversal order, so the ordered counts `test.js`
//! pins hold), the recursive paginated leaf walk, and the expansion-zoom
//! loop including the beyond-`maxZoom` case — so the Cluster Hierarchy this
//! exposes is drillable identically to supercluster's.
//!
//! Results reuse the [`ClusterFeature`]/[`FeatureKind`] shape from the query
//! half (ticket 04): a Cluster child carries its `cluster_id` + `num_points`,
//! a Point child (always a leaf, `num_points == 1`) carries its source
//! `feature_id` so the caller recovers the original feature from
//! [`Supercluster::points`]. Nothing here depends on `wasm-bindgen` or JSON.
//!
//! **Why this is separate from ticket 04's internal leaf path.** The 04
//! oracle recovers membership *in bulk* via a `parent_id -> children` map
//! (`child_index_for` in `query.rs`) for O(children) extraction with no
//! ordering requirement (the oracle sorts+dedupes). `get_children` here must
//! use the `within`+r scan so children come out in kd-tree traversal order
//! (`test.js` asserts ordered counts `[6, 7, 2, 1]`), and `get_leaves`
//! paginates. These are two genuinely different access patterns (bulk
//! unordered vs. per-cluster ordered), not duplication; leaving 04's path
//! untouched also preserves its O(n²)->O(n) perf fix at 1M scale.

use crate::cluster_id;
use crate::query::{ClusterFeature, FeatureKind};
use crate::supercluster::Supercluster;

impl Supercluster {
    /// `getChildren(clusterId)` — a Cluster's children on the next Zoom Level.
    ///
    /// Returns the Clusters and unclustered Points that were merged into
    /// `cluster_id` when it was created (its direct children in the Cluster
    /// Hierarchy), in kd-tree `within` traversal order — matching
    /// `refs/supercluster/index.js`'s `getChildren` (lines 115-141). Order
    /// matters: `test.js` asserts `getChildren(164)` yields point counts
    /// `[6, 7, 2, 1]`, so the children must come out in the same order JS
    /// supercluster produces, which is `tree.within` order.
    ///
    /// `cluster_id` is a JS-supercluster-compatible id (see `cluster_id.rs`):
    /// it encodes the cluster's origin point index and origin lattice zoom.
    /// The children live at the origin lattice zoom (one above the clustering
    /// zoom); they are the entries there whose `parent_id` equals `cluster_id`,
    /// found by scanning the `within(x, y, r)` neighbors of the cluster's
    /// origin point.
    ///
    /// Returns an empty `Vec` (no panic) if `cluster_id` does not decode to a
    /// built lattice entry — matching the crate's no-throw edge style
    /// (`load([])` / `get_clusters` never panic). JS supercluster throws "No
    /// cluster with the specified id." here, but `test.js` never probes an
    /// invalid id, and the crate avoids panics on the public surface.
    #[must_use]
    pub fn get_children(&self, cluster_id: u32) -> Vec<ClusterFeature> {
        let (origin_index, origin_lattice_zoom) =
            cluster_id::decode(cluster_id, self.stack.points_len);

        let Some(lattice) = self.stack.get(origin_lattice_zoom) else {
            // No lattice at the decoded origin zoom (e.g. an id that decodes
            // to a zoom below `minZoom` in a sparse stack, or a garbage id).
            return Vec::new();
        };

        // supercluster's `getChildren` guards `originId * stride >=
        // data.length`; here the lattice-index bound is `origin_index >=
        // lattice.len()`. A garbage id decoding past the end yields empty.
        if origin_index >= lattice.len() {
            return Vec::new();
        }

        // r = radius / (extent * 2^(originZoom - 1)). supercluster uses
        // `originZoom - 1` (the clustering zoom that created this cluster) as
        // the radius exponent, NOT `originZoom`. `radius_at_zoom(z)` computes
        // `radius / (extent * 2^z)`, so pass `origin_lattice_zoom - 1`.
        let r = self.options.radius_at_zoom(origin_lattice_zoom - 1);
        let x = lattice.x[origin_index];
        let y = lattice.y[origin_index];
        let ids = lattice.within(x, y, r);

        let mut children = Vec::new();
        for id in ids {
            let k = id as usize;
            if lattice.parent_id[k] == cluster_id {
                // `feature_at` surfaces the cluster's aggregated values
                // (ticket 06) identically to `get_clusters`, so drill-down
                // and viewport queries carry the same per-cluster props.
                children.push(self.feature_at(lattice, k));
            }
        }
        children
    }

    /// `getClusterExpansionZoom(clusterId)` — the Zoom Level at which a
    /// Cluster expands into multiple children.
    ///
    /// Returns the lowest zoom at which `cluster_id`'s viewport would show
    /// more than one entry (i.e. the cluster "breaks apart"), matching
    /// `refs/supercluster/index.js`'s `getClusterExpansionZoom` (lines
    /// 183-192). Includes the beyond-`maxZoom` case: a cluster that never
    /// breaks apart before `maxZoom` returns `maxZoom + 1`.
    ///
    /// A direct port of the JS loop: start at `originZoom - 1`, and while
    /// `expansionZoom <= maxZoom`, fetch the cluster's children, increment
    /// `expansionZoom`, and break as soon as the children count is not 1
    /// (following the single child cluster down the hierarchy). If the loop
    /// exhausts (the cluster stays a single child all the way through
    /// `maxZoom`), `expansionZoom` is `maxZoom + 1` on return.
    #[must_use]
    pub fn get_cluster_expansion_zoom(&self, mut cluster_id: u32) -> i32 {
        let (.., origin_lattice_zoom) = cluster_id::decode(cluster_id, self.stack.points_len);
        let mut expansion_zoom = origin_lattice_zoom - 1;
        while expansion_zoom <= self.options.max_zoom {
            let children = self.get_children(cluster_id);
            expansion_zoom += 1;
            if children.len() != 1 {
                break;
            }
            // Follow the single child down: it must be a Cluster (a cluster
            // always absorbs >= 1 neighbor, so a single child is itself a
            // sub-cluster carrying a `cluster_id`). If it is somehow a Point
            // (should not happen for a valid cluster id), stop — there is no
            // further cluster to descend into.
            match children[0].kind {
                FeatureKind::Cluster {
                    cluster_id: child_id,
                    ..
                } => cluster_id = child_id,
                FeatureKind::Point { .. } => break,
            }
        }
        expansion_zoom
    }

    /// `getLeaves(clusterId, limit, offset)` — paginate a Cluster's leaf
    /// Points.
    ///
    /// Returns up to `limit` leaf (unclustered source) Points of `cluster_id`,
    /// starting at `offset`, in depth-first traversal order — matching
    /// `refs/supercluster/index.js`'s `getLeaves`/`_appendLeaves` (lines
    /// 143-151, 194-220). `limit = None` returns all leaves (JS
    /// `limit = Infinity`).
    ///
    /// Leaves are always `FeatureKind::Point` (num_points == 1, at the raw
    /// lattice); each carries its source `feature_id` so the caller recovers
    /// the original feature from [`Supercluster::points`]. The walk skips
    /// whole sub-clusters (by their `num_points`) when they fall before
    /// `offset`, and recurses into them otherwise — the pagination semantics
    /// `test.js` pins (`getLeaves(164, 10, 5)` returns leaves 5..15).
    ///
    /// `offset` past the cluster's leaf count yields an empty `Vec` (no
    /// panic), matching the crate's no-throw edge style.
    #[must_use]
    pub fn get_leaves(
        &self,
        cluster_id: u32,
        limit: Option<usize>,
        offset: usize,
    ) -> Vec<ClusterFeature> {
        let mut leaves = Vec::new();
        self.append_leaves_paginated(&mut leaves, cluster_id, limit, offset, 0);
        leaves
    }

    /// Recursive depth-first leaf collection with pagination — a direct port
    /// of supercluster's `_appendLeaves` (lines 194-220).
    ///
    /// Walks `cluster_id`'s children (via [`get_children`], as JS does); for
    /// each child:
    ///   - a sub-Cluster whose `num_points` fits entirely before `offset` is
    ///     skipped wholesale (`skipped += num_points`);
    ///   - a sub-Cluster overlapping `offset` is recursed into, threading
    ///     `skipped` through;
    ///   - a Point before `offset` is skipped (`skipped += 1`);
    ///   - a Point at/after `offset` is appended.
    ///
    /// Stops as soon as `limit` is satisfied (JS `result.length === limit`).
    /// Returns the running `skipped` count, as JS does (the recursion threads
    /// it so a skipped sub-cluster's count propagates to its siblings).
    ///
    /// Distinct from ticket 04's `query.rs::append_leaves` (which collects
    /// raw source ids in bulk via the `child_index` map, unordered, for the
    /// oracle); this one walks the public `get_children` surface in
    /// kd-tree order with pagination, for `get_leaves`.
    fn append_leaves_paginated(
        &self,
        result: &mut Vec<ClusterFeature>,
        cluster_id: u32,
        limit: Option<usize>,
        offset: usize,
        mut skipped: usize,
    ) -> usize {
        let children = self.get_children(cluster_id);
        for child in children {
            match &child.kind {
                FeatureKind::Cluster {
                    cluster_id: child_id,
                    num_points,
                    ..
                } => {
                    if skipped + *num_points as usize <= offset {
                        // Skip the whole sub-cluster.
                        skipped += *num_points as usize;
                    } else {
                        // Enter the sub-cluster.
                        skipped = self.append_leaves_paginated(
                            result,
                            *child_id,
                            limit,
                            offset,
                            skipped,
                        );
                    }
                }
                FeatureKind::Point { .. } => {
                    if skipped < offset {
                        // Skip a single point.
                        skipped += 1;
                    } else {
                        // Add a single point.
                        result.push(child);
                    }
                }
            }
            if let Some(l) = limit {
                if result.len() == l {
                    break;
                }
            }
        }
        skipped
    }
}
