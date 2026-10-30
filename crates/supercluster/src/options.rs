//! Clustering options, matching supercluster's defaults and radius formula.
//!
//! A direct port of `refs/supercluster/index.js`'s `defaultOptions` and the
//! `r = radius / (extent * 2^zoom)` radius-per-zoom formula. The defaults are
//! preserved verbatim (radius 40, extent 512, minPoints 2, maxZoom 16, nodeSize
//! 64) because the semantic-equivalence oracle requires identical pruning
//! boundaries — any drift in these would shift boundary-point membership and
//! fuzz the very contract that makes "performance gain" falsifiable (ADR 0003).
//!
//! `minZoom` and `generateId`/`reduce`/`map` are part of supercluster's option
//! surface but out of scope for this ticket: `reduce`/`map` are replaced by the
//! declarative aggregation spec (ticket 06, [`AggregationSpec`]), and
//! `generateId`/`minZoom` only affect the query half (ticket 04). `minZoom`
//! defaults to 0 and is honored by the build loop so the lattice is
//! constructed over `[minZoom, maxZoom]`.
//!
//! `Options` is `Clone` but not `Copy` once an `AggregationSpec` is set (the
//! spec holds an `Arc`'d field list). Callers that override a field via
//! `..Options::default()` are unaffected; the spec defaults to empty (no
//! aggregation — clusters carry `point_count` only).

use crate::aggregation::AggregationSpec;

/// Clustering options. Defaults match supercluster verbatim.
///
/// Construct with [`Options::default`] for supercluster's out-of-the-box
/// behavior, or override individual fields. The radius-per-zoom formula
/// ([`Options::radius_at_zoom`]) is supercluster's, used by both the build
/// loop (ticket 03) and the query half (ticket 04) so the oracle's pruning
/// boundaries align.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    /// Minimum zoom to generate clusters on. Default `0`.
    pub min_zoom: i32,
    /// Maximum zoom level to cluster points on. Default `16`.
    pub max_zoom: i32,
    /// Minimum points to form a cluster. Default `2`.
    pub min_points: u32,
    /// Cluster radius in pixels. Default `40`.
    pub radius: f64,
    /// Tile extent (radius is calculated relative to it). Default `512`.
    pub extent: f64,
    /// KD-tree leaf node size. Default `64`.
    pub node_size: u32,
    /// Declarative aggregation spec (ticket 06). Default empty (no spec) —
    /// clusters carry `point_count` only. When set, the build loop folds
    /// per-cluster accumulators and the query half surfaces them in
    /// `getClusters`. Replaces JS supercluster's `reduce`/`map` callbacks.
    pub spec: AggregationSpec,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            min_zoom: 0,
            max_zoom: 16,
            min_points: 2,
            radius: 40.0,
            extent: 512.0,
            node_size: 64,
            spec: AggregationSpec::new(),
        }
    }
}

impl Options {
    /// Cluster radius in `[0..1]` space at `zoom`, matching supercluster's
    /// `r = radius / (extent * 2^zoom)`.
    ///
    /// `zoom` is the clustering zoom (the build loop runs `maxZoom` down to
    /// `minZoom`, calling this with the current zoom). The query half (ticket
    /// 04) reuses this for `getClusters`'s bbox queries at the limited zoom;
    /// `getChildren` uses a radius at the cluster's *origin* zoom, whose exact
    /// zoom/radius convention is pinned down against `test.js` when that half
    /// lands — not asserted here to avoid a premature, possibly-wrong claim.
    #[must_use]
    pub fn radius_at_zoom(&self, zoom: i32) -> f64 {
        self.radius / (self.extent * 2f64.powi(zoom))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_supercluster() {
        let o = Options::default();
        assert_eq!(o.min_zoom, 0);
        assert_eq!(o.max_zoom, 16);
        assert_eq!(o.min_points, 2);
        assert_eq!(o.radius, 40.0);
        assert_eq!(o.extent, 512.0);
        assert_eq!(o.node_size, 64);
    }

    #[test]
    fn radius_at_zoom_matches_supercluster_formula() {
        let o = Options::default();
        // r = radius / (extent * 2^zoom)
        for z in 0..=16 {
            let expected = 40.0 / (512.0 * 2f64.powi(z));
            assert_eq!(o.radius_at_zoom(z), expected, "zoom {z}");
        }
    }

    #[test]
    fn radius_at_zoom_decreases_with_zoom() {
        // Higher zooms resolve finer clusters: the radius in [0..1] space
        // halves each zoom, so a cluster at z=0 spans far more of the world
        // than the same pixel radius at z=16.
        let o = Options::default();
        assert!(o.radius_at_zoom(0) > o.radius_at_zoom(1));
        assert!((o.radius_at_zoom(0) / o.radius_at_zoom(1) - 2.0).abs() < 1e-9);
    }
}
