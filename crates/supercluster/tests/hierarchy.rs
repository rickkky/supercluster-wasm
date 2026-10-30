//! Cluster Hierarchy drill-down acceptance (ticket 05): `get_children`,
//! `get_leaves`, and `get_cluster_expansion_zoom` behave identically to JS
//! supercluster — verified against `refs/supercluster/test/test.js`'s expected
//! outputs (ordered child counts, named paginated leaves, null-property leaf,
//! expansion zooms including the beyond-`maxZoom` case).
//!
//! These are behavior tests against `refs/supercluster/index.js`'s `test.js`
//! cases, ported to Rust inputs. The cluster ids are JS-supercluster-
//! compatible (see `cluster_id.rs`): Rust offsets cluster ids above the full
//! input feature count, matching JS `this.points.length`, so the literal ids
//! `test.js` uses (164, 196, 581, 1157, 4134, 2504, 165) work as direct
//! arguments with no translation.

mod common;

use supercluster::feature::PointFeature;
use supercluster::options::Options;
use supercluster::query::FeatureKind;
use supercluster::supercluster::Supercluster;

/// The default-options index over `places.json` (163 features, one
/// `geometry: null`) — the `test.js` setup for the `getChildren`/
/// `getLeaves`/`getClusterExpansionZoom` cases. Built once per test to keep
/// them independent.
fn places_index() -> Supercluster {
    Supercluster::load(common::load_places(), Options::default())
}

/// Map a child entry to the count `test.js` compares against: a Cluster's
/// `point_count`, or `1` for an unclustered Point (JS's
/// `p.properties.point_count || 1`).
fn child_count(f: &supercluster::query::ClusterFeature) -> u32 {
    match f.kind {
        FeatureKind::Cluster { num_points, .. } => num_points,
        FeatureKind::Point { .. } => 1,
    }
}

#[test]
fn get_children_164_yields_counts_6_7_2_1() {
    // test.js "returns children of a cluster": getChildren(164) yields point
    // counts [6, 7, 2, 1], in that order. Order matters — the children come
    // out in kd-tree `within` traversal order, and test.js deep-equals the
    // ordered array.
    let index = places_index();
    let counts: Vec<u32> = index.get_children(164).iter().map(child_count).collect();
    assert_eq!(counts, [6, 7, 2, 1], "getChildren(164) counts must match JS [6,7,2,1]");
}

#[test]
fn get_leaves_164_limit10_offset5_yields_named_leaves() {
    // test.js "returns leaves of a cluster": getLeaves(164, 10, 5) returns
    // these 10 leaf names, in order. The leaves are unclustered source points;
    // each carries a `feature_id` indexing into `Supercluster::points`, whose
    // `properties` (raw JSON bytes) carry the `name`.
    let index = places_index();
    let leaves = index.get_leaves(164, Some(10), 5);
    assert_eq!(leaves.len(), 10, "limit 10 must return 10 leaves");
    let names: Vec<String> = leaves
        .iter()
        .map(|f| match f.kind {
            FeatureKind::Point { feature_id } => {
                let props = &index.points[feature_id as usize].properties;
                let bytes = props.as_ref().expect("places.json leaves have properties");
                let v: serde_json::Value = serde_json::from_slice(bytes).expect("valid JSON");
                v.get("name")
                    .and_then(|n| n.as_str())
                    .expect("leaf has a name")
                    .to_string()
            }
            FeatureKind::Cluster { .. } => panic!("leaves must be Points, not Clusters"),
        })
        .collect();
    assert_eq!(
        names,
        [
            "Niagara Falls",
            "Cape San Blas",
            "Cape Sable",
            "Cape Canaveral",
            "San  Salvador",
            "Cabo Gracias a Dios",
            "I. de Cozumel",
            "Grand Cayman",
            "Miquelon",
            "Cape Bauld",
        ],
        "getLeaves(164, 10, 5) leaf names must match test.js"
    );
}

#[test]
fn get_leaves_165_limit1_offset6_is_null_property() {
    // test.js "getLeaves handles null-property features": load places.json
    // plus one null-property feature at [-79.04411780507252, 43.08771393436908],
    // then getLeaves(165, 1, 6)[0].properties === null. The appended feature is
    // the null-property leaf at offset 6 of cluster 165.
    let mut points = common::load_places();
    points.push(PointFeature::new(-79.04411780507252, 43.08771393436908));
    let index = Supercluster::load(points, Options::default());
    let leaves = index.get_leaves(165, Some(1), 6);
    assert_eq!(leaves.len(), 1, "limit 1 must return 1 leaf");
    let feature_id = match leaves[0].kind {
        FeatureKind::Point { feature_id } => feature_id,
        FeatureKind::Cluster { .. } => panic!("leaf must be a Point"),
    };
    assert!(
        index.points[feature_id as usize].properties.is_none(),
        "leaf at offset 6 of cluster 165 must be the null-property feature"
    );
}

#[test]
fn get_cluster_expansion_zoom_places() {
    // test.js "returns cluster expansion zoom": for the default-options
    // places.json index, these ids expand at these zooms.
    let index = places_index();
    assert_eq!(index.get_cluster_expansion_zoom(164), 1);
    assert_eq!(index.get_cluster_expansion_zoom(196), 1);
    assert_eq!(index.get_cluster_expansion_zoom(581), 2);
    assert_eq!(index.get_cluster_expansion_zoom(1157), 2);
    assert_eq!(index.get_cluster_expansion_zoom(4134), 3);
}

#[test]
fn get_cluster_expansion_zoom_beyond_maxzoom() {
    // test.js "returns cluster expansion zoom for maxZoom": with
    // {radius:60, extent:256, maxZoom:4}, getClusterExpansionZoom(2504) === 5
    // (maxZoom + 1) — the cluster never breaks apart before maxZoom, so the
    // loop exhausts and returns maxZoom + 1.
    let index = Supercluster::load(
        common::load_places(),
        Options {
            radius: 60.0,
            extent: 256.0,
            max_zoom: 4,
            ..Options::default()
        },
    );
    assert_eq!(index.get_cluster_expansion_zoom(2504), 5, "beyond-maxZoom case must return maxZoom+1");
}

#[test]
fn get_leaves_none_limit_returns_all() {
    // limit = None (JS Infinity) returns all of the cluster's leaves. Cluster
    // 164 has 16 leaves (6 + 7 + 2 + 1 from getChildren(164)), so None and
    // Some(16) at offset 0 must return the same 16.
    let index = places_index();
    let all = index.get_leaves(164, None, 0);
    let capped = index.get_leaves(164, Some(16), 0);
    assert_eq!(all.len(), 16, "cluster 164 has 16 leaves");
    assert_eq!(capped.len(), 16, "Some(16) returns all 16");
    // Same set of feature_ids (order is identical for the same walk).
    let ids_all: Vec<u32> = all
        .iter()
        .map(|f| match f.kind {
            FeatureKind::Point { feature_id } => feature_id,
            FeatureKind::Cluster { .. } => unreachable!("leaves are Points"),
        })
        .collect();
    let ids_capped: Vec<u32> = capped
        .iter()
        .map(|f| match f.kind {
            FeatureKind::Point { feature_id } => feature_id,
            FeatureKind::Cluster { .. } => unreachable!("leaves are Points"),
        })
        .collect();
    assert_eq!(ids_all, ids_capped, "None and Some(16) return the same leaves in order");
}

#[test]
fn get_children_invalid_id_returns_empty_no_panic() {
    // The crate's no-throw edge style: an id that does not decode to a built
    // lattice entry returns an empty Vec rather than panicking (JS supercluster
    // throws "No cluster with the specified id.", but the crate avoids panics
    // on the public surface and test.js never probes an invalid id).
    let index = places_index();
    // u32::MAX decodes to an origin zoom past the built stack and an origin
    // index past the lattice length.
    let result = index.get_children(u32::MAX);
    assert!(result.is_empty(), "invalid cluster id must return empty, not panic");
}

#[test]
fn get_leaves_offset_past_end_returns_empty_no_panic() {
    // An offset past the cluster's leaf count yields an empty Vec (no panic),
    // matching the no-throw edge style.
    let index = places_index();
    let result = index.get_leaves(164, Some(10), 10_000);
    assert!(result.is_empty(), "offset past the leaf count must return empty");
}
