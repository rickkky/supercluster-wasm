//! Aggregation surfacing in `get_clusters` (ticket 06, Task 5).
//!
//! Behavior tests for the query half's aggregation surfacing: a Cluster
//! built with an [`AggregationSpec`] carries the per-spec-field aggregated
//! values in its `ClusterFeature`, and a Cluster built with *no* spec
//! carries `point_count` only (no aggregated field). The per-Cluster sum
//! matching JS supercluster's `reduce` is pinned by the fixture-pinned
//! oracle in `tests/aggregates.rs` (Task 6); these tests pin the surfacing
//! contract and the fold's correctness on hand-computable inputs.

mod common;

use supercluster::aggregation::{AggOp, AggregationSpec};
use supercluster::feature::PointFeature;
use supercluster::options::Options;
use supercluster::query::FeatureKind;
use supercluster::supercluster::Supercluster;

/// Build a tight 3-point cluster (all at the same spot) + 1 far singleton,
/// each carrying a `value` numeric property. With `maxZoom: 0` and default
/// radius, the 3 co-located points form one cluster; the far point stays a
/// singleton. The cluster's `sum` = 10+20+30 = 60, `count` = 3, `min` = 10,
/// `max` = 30, `mean` = 20.
fn tight_cluster_with_values() -> Vec<PointFeature> {
    vec![
        PointFeature::new(0.0, 0.0).with_numeric("value", 10.0),
        PointFeature::new(0.0, 0.0).with_numeric("value", 20.0),
        PointFeature::new(0.0, 0.0).with_numeric("value", 30.0),
        // Far singleton — outside the cluster radius at z=0.
        PointFeature::new(100.0, 0.0).with_numeric("value", 1000.0),
    ]
}

/// A spec covering all five ops over `value`.
fn full_spec() -> AggregationSpec {
    AggregationSpec::new()
        .with("sum", "value", AggOp::Sum)
        .with("count", "value", AggOp::Count)
        .with("min", "value", AggOp::Min)
        .with("max", "value", AggOp::Max)
        .with("mean", "value", AggOp::Mean)
}

/// Look up a finalized aggregated value by name (test helper).
fn agg_value<'a>(agg: &'a [(String, f64)], name: &str) -> Option<&'a f64> {
    agg.iter().find(|(n, _)| n == name).map(|(_, v)| v)
}

#[test]
fn cluster_surfaces_all_five_aggregated_values() {
    let points = tight_cluster_with_values();
    let options = Options {
        max_zoom: 0,
        spec: full_spec(),
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let features = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);

    // One cluster (3 points) + one singleton.
    let clusters: Vec<_> = features
        .iter()
        .filter_map(|f| match &f.kind {
            FeatureKind::Cluster { aggregated, .. } => Some(aggregated),
            _ => None,
        })
        .collect();
    assert_eq!(clusters.len(), 1, "exactly one cluster at z=0");
    let agg = &clusters[0];

    // Sum 10+20+30 = 60.
    assert_eq!(agg_value(agg, "sum"), Some(&60.0));
    // Count of values = 3.
    assert_eq!(agg_value(agg, "count"), Some(&3.0));
    // Min = 10, Max = 30.
    assert_eq!(agg_value(agg, "min"), Some(&10.0));
    assert_eq!(agg_value(agg, "max"), Some(&30.0));
    // Mean = 60/3 = 20.
    assert!((*agg_value(agg, "mean").unwrap() - 20.0).abs() < 1e-12);
}

#[test]
fn cluster_without_spec_carries_no_aggregated_field() {
    // The "no spec" common case (User Story 8): clusters carry `point_count`
    // only. `aggregated` is empty.
    let points = tight_cluster_with_values();
    let options = Options {
        max_zoom: 0,
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let features = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    for f in &features {
        if let FeatureKind::Cluster { aggregated, .. } = &f.kind {
            assert!(aggregated.is_empty(), "no spec => no aggregated field");
        }
    }
}

#[test]
fn singleton_point_has_no_aggregated_field() {
    // Unclustered points never carry aggregated properties — they surface the
    // original source feature, not a reduced cluster. Only Clusters carry
    // `aggregated`. The far singleton (value 1000) must surface as a Point
    // (not folded into the cluster), and a Point variant carries no
    // aggregated field by construction of the enum.
    let points = tight_cluster_with_values();
    let options = Options {
        max_zoom: 0,
        spec: full_spec(),
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let features = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let mut has_cluster = false;
    let mut has_point = false;
    for f in &features {
        match &f.kind {
            FeatureKind::Cluster { aggregated, .. } => {
                has_cluster = true;
                // The cluster's aggregated field is populated (sum/count/min/
                // max/mean over the three co-located values 10/20/30).
                assert!(!aggregated.is_empty(), "cluster must carry aggregated values");
            }
            FeatureKind::Point { .. } => {
                has_point = true;
                // No aggregated field on the Point variant — the enum has
                // none, so there is nothing to read here. The assertion is
                // structural: a Point cannot carry aggregated props.
            }
        }
    }
    assert!(has_cluster, "the tight cluster must surface as a Cluster");
    assert!(has_point, "the far singleton must surface as a Point");
}

#[test]
fn missing_property_contributes_nothing_to_sum() {
    // A point missing the aggregated property contributes nothing (its
    // accumulator stays at the identity, 0 for Sum). Two points with `value`
    // and one without: sum = 10 + 20 + 0 = 30, count = 2 (only two carry it).
    let points = vec![
        PointFeature::new(0.0, 0.0).with_numeric("value", 10.0),
        PointFeature::new(0.0, 0.0).with_numeric("value", 20.0),
        PointFeature::new(0.0, 0.0), // no `value`
    ];
    let options = Options {
        max_zoom: 0,
        spec: AggregationSpec::new()
            .with("sum", "value", AggOp::Sum)
            .with("count", "value", AggOp::Count),
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let features = index.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let agg = features
        .iter()
        .filter_map(|f| match &f.kind {
            FeatureKind::Cluster { aggregated, .. } => Some(aggregated),
            _ => None,
        })
        .next()
        .expect("a cluster forms");
    assert_eq!(agg_value(agg, "sum"), Some(&30.0));
    assert_eq!(agg_value(agg, "count"), Some(&2.0));
}
