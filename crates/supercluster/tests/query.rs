//! Query-half acceptance for ticket 04: `get_clusters` matches JS
//! supercluster's `getClusters` behavior — viewport extraction, antimeridian
//! wrapping, bbox/zoom edge handling — and the whole-world query returns the
//! full Cluster Lattice (the count the build half's `places.rs` pinned).
//!
//! These are behavior tests against `refs/supercluster/index.js`'s `test.js`
//! cases, ported to Rust inputs. The full membership equivalence (not just
//! counts) lives in `oracle.rs`, which diffs Rust `get_clusters` membership
//! against captured JS-supercluster membership fixtures.

mod common;

use supercluster::feature::PointFeature;
use supercluster::query::{ClusterFeature, FeatureKind};
use supercluster::supercluster::Supercluster;

/// JS supercluster's top-level entry count per zoom for `places.json` with
/// `maxZoom: 6` (the oracle's `DEFAULT_OPTIONS`), the same literals `places.rs`
/// pins. `get_clusters([-180, -90, 180, 90], z)` must return exactly this many
/// entries at each zoom — the whole-world query is the full lattice.
const EXPECTED_TOP_LEVEL: [u32; 8] = [32, 61, 100, 137, 149, 159, 162, 162];

/// `get_clusters` over the whole-world bbox returns one entry per top-level
/// lattice entry (the full Cluster Lattice, not a viewport slice). This is the
/// query-half equivalent of `places.rs`'s count check: the build pinned the
/// *lattice* count; here the *query* must surface the same count.
fn whole_world_count(index: &Supercluster, zoom: i32) -> usize {
    index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], f64::from(zoom)).len()
}

#[test]
fn whole_world_query_returns_full_lattice_at_each_zoom() {
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    for z in 0..=7 {
        assert_eq!(
            whole_world_count(&index, z),
            EXPECTED_TOP_LEVEL[z as usize] as usize,
            "zoom {z}: get_clusters whole-world count {} != JS supercluster's {}",
            whole_world_count(&index, z),
            EXPECTED_TOP_LEVEL[z as usize]
        );
    }
}

#[test]
fn whole_world_query_count_matches_lattice_len() {
    // The query result count must equal the built lattice's entry count at
    // every zoom — `get_clusters` extracts exactly the lattice's top-level
    // entries over the whole world, no more, no fewer.
    let points = common::uniform_random(1000, 42);
    let index = Supercluster::load(points, common::oracle_options());
    for z in 0..=index.options.max_zoom + 1 {
        let lattice = index.stack.get(z).expect("lattice built");
        assert_eq!(
            whole_world_count(&index, z),
            lattice.len(),
            "zoom {z}: query count {} != lattice len {}",
            whole_world_count(&index, z),
            lattice.len()
        );
    }
}

#[test]
fn empty_input_yields_empty_results_without_panic() {
    // User Story 9 / test.js "does not throw on zero items": `load([])` then
    // `getClusters` returns `[]`.
    let index = Supercluster::load(Vec::new(), common::oracle_options());
    let result = index.get_clusters(&[-180.0, -85.0, 180.0, 85.0], 0.0);
    assert!(result.is_empty(), "empty input -> empty get_clusters");
}

#[test]
fn non_integer_zoom_floors_to_integer() {
    // test.js "does not crash on non-integer zoom values": zoom 1.25 must
    // behave as zoom 1 (floor). Querying the antimeridian-crossing bbox at
    // 1.25 must not panic and must equal the zoom-1 result.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let at_1 = index.get_clusters(&[179.0, -10.0, -177.0, 10.0], 1.0);
    let at_1_25 = index.get_clusters(&[179.0, -10.0, -177.0, 10.0], 1.25);
    assert_eq!(at_1, at_1_25, "zoom 1.25 must floor to zoom 1");
}

#[test]
fn zoom_above_max_zoom_clamps_to_max_zoom_plus_1() {
    // `_limitZoom` clamps zooms above maxZoom+1 down to maxZoom+1 (the raw
    // lattice). A zoom of 100 over places.json must equal zoom 7 (maxZoom+1).
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let at_7 = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 7.0);
    let at_100 = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 100.0);
    assert_eq!(at_100, at_7, "zoom 100 must clamp to maxZoom+1=7");
}

#[test]
fn zoom_below_min_zoom_clamps_to_min_zoom() {
    // `_limitZoom` clamps negative zooms up to minZoom (0 by default). A zoom
    // of -5 must equal zoom 0.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let at_0 = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let at_neg = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], -5.0);
    assert_eq!(at_neg, at_0, "zoom -5 must clamp to minZoom=0");
}

#[test]
fn out_of_range_latitudes_clamp_not_reject() {
    // test.js edge behavior: latitudes outside [-90, 90] clamp, not reject.
    // A bbox with lat > 90 and lat < -90 must clamp and return the same set as
    // the whole-world query at that zoom.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let normal = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 1.0);
    let clamped = index.get_clusters(&[-180.0, -999.0, 180.0, 999.0], 1.0);
    // Sort by a stable key (cluster_id / feature_id) before comparing, since
    // kd-tree traversal order is identical for identical queries but the two
    // bboxes differ in input (though they project to the same box after clamp).
    assert_eq!(canonical(&clamped), canonical(&normal));
}

#[test]
fn bbox_spanning_360_collapses_to_whole_world() {
    // supercluster line 95: a bbox whose lng span >= 360 collapses to
    // [-180, 180]. A bbox like [-200, -90, 200, 90] (span 400) must return the
    // whole-world set.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let whole = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 1.0);
    let span = index.get_clusters(&[-200.0, -90.0, 200.0, 90.0], 1.0);
    assert_eq!(canonical(&span), canonical(&whole));
}

#[test]
fn antimeridian_crossing_splits_and_concatenates() {
    // test.js "returns clusters when query crosses international dateline":
    // four points near -179°, queried at zoom 1. A non-crossing bbox
    // [-179, -10, -177, 10] and a crossing bbox [179, -10, -177, 10] must
    // return the same count (the crossing query wraps and picks up the same
    // points).
    let points = vec![
        PointFeature::new(-178.989, 0.0),
        PointFeature::new(-178.990, 0.0),
        PointFeature::new(-178.991, 0.0),
        PointFeature::new(-178.992, 0.0),
    ];
    let index = Supercluster::load(points, common::oracle_options());
    let non_crossing = index.get_clusters(&[-179.0, -10.0, -177.0, 10.0], 1.0);
    let crossing = index.get_clusters(&[179.0, -10.0, -177.0, 10.0], 1.0);
    assert!(!non_crossing.is_empty(), "non-crossing query must find points");
    assert!(!crossing.is_empty(), "crossing query must find points");
    assert_eq!(non_crossing.len(), crossing.len(), "crossing and non-crossing must match");
}

#[test]
fn weird_bbox_values_do_not_crash_and_match_js_counts() {
    // test.js "does not crash on weird bbox values": the pinned counts JS
    // supercluster returns for these bboxes over places.json at zoom 1. These
    // bboxes have out-of-range longitudes that wrap, exercising the mod-360
    // normalization and antimeridian split.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    // (bbox, expected JS count) — captured from refs/supercluster/index.js.
    let cases: [([f64; 4], usize); 7] = [
        ([129.426390, -103.720017, -445.930843, 114.518236], 26),
        ([112.207836, -84.578666, -463.149397, 120.169159], 27),
        ([129.886277, -82.332680, -445.470956, 120.390930], 26),
        ([458.220043, -84.239039, -117.137190, 120.206585], 25),
        ([456.713058, -80.354196, -118.644175, 120.539148], 25),
        ([453.105328, -75.857422, -122.251904, 120.732760], 25),
        ([-180.0, -90.0, 180.0, 90.0], 61),
    ];
    for (bbox, expected) in cases {
        let result = index.get_clusters(&bbox, 1.0);
        assert_eq!(
            result.len(),
            expected,
            "bbox {bbox:?}: count {} != JS supercluster's {}",
            result.len(),
            expected
        );
    }
}

#[test]
fn cluster_results_carry_cluster_id_and_num_points() {
    // A Cluster result entry must carry its cluster_id (>= points_len, the
    // offset that keeps cluster ids disjoint from source ids) and num_points
    // (> 1). An unclustered Point entry carries a feature_id (< points_len).
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let result = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let points_len = index.stack.points_len;
    let mut found_cluster = false;
    let mut found_point = false;
    for f in result {
        match f.kind {
            FeatureKind::Cluster { cluster_id, num_points, .. } => {
                found_cluster = true;
                assert!(
                    cluster_id as usize >= points_len,
                    "cluster id {cluster_id} must be offset above points_len {points_len}"
                );
                assert!(num_points > 1, "cluster num_points must be > 1");
            }
            FeatureKind::Point { feature_id } => {
                found_point = true;
                assert!(
                    (feature_id as usize) < points_len,
                    "feature id {feature_id} must be a source id (< points_len {points_len})"
                );
            }
        }
    }
    assert!(found_cluster, "zoom 0 over places.json must have clusters");
    assert!(found_point, "zoom 0 over places.json must have unclustered points");
}

#[test]
fn cluster_result_coordinates_are_within_projected_unit_square() {
    // All result coordinates lie in [0, 1] projected space (clusters are
    // weighted centers of in-range points; unclustered points are projected
    // source coords). Antimeridian-wrapped points may project to x > 1, but
    // places.json has none, so the whole-world query stays in [0, 1].
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    for z in 0..=index.options.max_zoom {
        for f in index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], f64::from(z)) {
            assert!((0.0..=1.0).contains(&f.x), "zoom {z}: x {} out of [0,1]", f.x);
            assert!((0.0..=1.0).contains(&f.y), "zoom {z}: y {} out of [0,1]", f.y);
        }
    }
}

/// Canonicalize a result slice for order-independent comparison: sort by the
/// entry's id (cluster_id for a Cluster, feature_id for a Point). Used where
/// two bboxes project to the same query box but differ in input — the
/// kd-tree traversal order is identical, but compare canonically to be safe.
fn canonical(features: &[ClusterFeature]) -> Vec<u64> {
    let mut ids: Vec<u64> = features
        .iter()
        .map(|f| match f.kind {
            FeatureKind::Cluster { cluster_id, .. } => cluster_id as u64,
            FeatureKind::Point { feature_id } => feature_id as u64,
        })
        .collect();
    ids.sort_unstable();
    ids
}
