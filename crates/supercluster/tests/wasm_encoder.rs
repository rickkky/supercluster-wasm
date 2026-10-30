//! Sub-seam B (ticket 07): the compact typed-array result encoding.
//!
//! The WASM↔JS boundary contract is "the typed array a WASM call returns
//! decodes to the expected id+coord+count+cluster/point-tag set for a given
//! query" (spec, Testing Decisions). The encoding is the part that matters, so
//! it is a pure-Rust function (`encode_results`) testable with plain `cargo
//! test` — no wasm32 target, no `wasm-bindgen`, fast iteration. The FFI shell
//! in `src/wasm.rs` is a thin caller.
//!
//! Layout (Float64Array, per the ADR 0003 f64-center amendment — see
//! `docs/adr/0003`):
//! - row buffer, stride 5: `[lng, lat, id, num_points, tag]`
//!   - lng/lat = `x_lng`/`y_lat` of the feature's projected `[0..1]` x/y
//!   - id = cluster_id (Cluster) or feature_id (Point); u32 as f64 (exact)
//!   - num_points = cluster's num_points (Cluster) or 1 (Point); u32 as f64
//!   - tag = 0.0 (Point) | 1.0 (Cluster)
//! - aggregated buffer, stride `spec_len`: finalized values in spec order,
//!   empty when `spec_len == 0`.

use supercluster::encode::encode_results;
use supercluster::projection::{lat_y, lng_x, x_lng, y_lat};
use supercluster::query::{ClusterFeature, FeatureKind};

/// Build a Point feature at a known lng/lat. `feature_id` indexes the
/// geometry-bearing subset (the source-id space).
fn point(feature_id: u32, lng: f64, lat: f64) -> ClusterFeature {
    ClusterFeature {
        x: lng_x(lng),
        y: lat_y(lat),
        kind: FeatureKind::Point { feature_id },
    }
}

/// Build a Cluster feature at a known lng/lat with the given aggregated values.
fn cluster(cluster_id: u32, num_points: u32, lng: f64, lat: f64, aggregated: Vec<(&str, f64)>) -> ClusterFeature {
    ClusterFeature {
        x: lng_x(lng),
        y: lat_y(lat),
        kind: FeatureKind::Cluster {
            cluster_id,
            num_points,
            aggregated: aggregated.into_iter().map(|(n, v)| (n.to_string(), v)).collect(),
        },
    }
}

#[test]
fn empty_input_yields_empty_buffers_and_zero_count() {
    let (rows, agg, count) = encode_results(&[], 0);
    assert!(rows.is_empty(), "row buffer must be empty for no features");
    assert!(agg.is_empty(), "aggregated buffer must be empty for no features");
    assert_eq!(count, 0);
}

#[test]
fn point_encodes_to_lng_lat_feature_id_one_and_point_tag() {
    let f = point(7, -79.04, 43.08);
    let (rows, agg, count) = encode_results(&[f], 0);
    assert_eq!(count, 1);
    assert_eq!(rows.len(), 5, "one row = 5 f64 slots");
    assert!(agg.is_empty(), "no spec -> empty aggregated buffer");

    // lng/lat must be the inverse projection of the stored x/y.
    assert!(
        (rows[0] - (-79.04)).abs() < 1e-9,
        "lng slot {} != -79.04",
        rows[0]
    );
    assert!(
        (rows[1] - 43.08).abs() < 1e-9,
        "lat slot {} != 43.08",
        rows[1]
    );
    // id = feature_id, num_points = 1, tag = 0 (point).
    assert_eq!(rows[2], 7.0, "id slot must be the feature_id");
    assert_eq!(rows[3], 1.0, "num_points slot must be 1 for a point");
    assert_eq!(rows[4], 0.0, "tag slot must be 0 for a point");
}

#[test]
fn cluster_encodes_to_lng_lat_cluster_id_num_points_and_cluster_tag() {
    let f = cluster(1000, 42, 13.4, 52.5, vec![]);
    let (rows, agg, count) = encode_results(&[f], 0);
    assert_eq!(count, 1);
    assert_eq!(rows.len(), 5);
    assert!(agg.is_empty(), "spec_len 0 -> empty aggregated buffer");

    assert!((rows[0] - 13.4).abs() < 1e-9, "lng slot {}", rows[0]);
    assert!((rows[1] - 52.5).abs() < 1e-9, "lat slot {}", rows[1]);
    assert_eq!(rows[2], 1000.0, "id slot must be the cluster_id");
    assert_eq!(rows[3], 42.0, "num_points slot must be the cluster's count");
    assert_eq!(rows[4], 1.0, "tag slot must be 1 for a cluster");
}

#[test]
fn cluster_with_spec_emits_aggregated_values_in_spec_order() {
    // spec_len = 2; the cluster carries two finalized values.
    let f = cluster(5, 10, 0.0, 0.0, vec![("sum", 25.0), ("max", 9.0)]);
    let (rows, agg, count) = encode_results(&[f], 2);
    assert_eq!(count, 1);
    assert_eq!(rows.len(), 5);
    assert_eq!(agg.len(), 2, "one cluster * spec_len 2 = 2 aggregated slots");
    assert_eq!(agg[0], 25.0, "first spec field value");
    assert_eq!(agg[1], 9.0, "second spec field value");
}

#[test]
fn mixed_point_cluster_sequence_preserves_stride_and_tags() {
    // point, cluster, cluster, point — with spec_len 1.
    let features = [
        point(0, -10.0, -20.0),
        cluster(100, 3, 1.0, 2.0, vec![("v", 5.0)]),
        cluster(101, 4, 3.0, 4.0, vec![("v", 7.0)]),
        point(1, 10.0, 20.0),
    ];
    let (rows, agg, count) = encode_results(&features, 1);
    assert_eq!(count, 4, "count must equal the feature count");
    assert_eq!(rows.len(), 4 * 5, "4 rows * stride 5");
    // The aggregated buffer is cluster-dense: only clusters carry values, packed
    // contiguously. Two clusters * spec_len 1 = 2 slots (points contribute none).
    assert_eq!(agg.len(), 2, "two clusters * spec_len 1; points carry no agg slots");

    // Row 0: point (tag 0).
    assert_eq!(rows[0 * 5 + 4], 0.0, "row 0 tag");
    assert_eq!(rows[0 * 5 + 2], 0.0, "row 0 id = feature_id 0");
    // Row 1: cluster (tag 1).
    assert_eq!(rows[1 * 5 + 4], 1.0, "row 1 tag");
    assert_eq!(rows[1 * 5 + 2], 100.0, "row 1 id = cluster_id 100");
    assert_eq!(rows[1 * 5 + 3], 3.0, "row 1 num_points");
    // Row 2: cluster (tag 1).
    assert_eq!(rows[2 * 5 + 4], 1.0, "row 2 tag");
    assert_eq!(rows[2 * 5 + 2], 101.0, "row 2 id = cluster_id 101");
    // Row 3: point (tag 0).
    assert_eq!(rows[3 * 5 + 4], 0.0, "row 3 tag");
    assert_eq!(rows[3 * 5 + 2], 1.0, "row 3 id = feature_id 1");

    // Aggregated: only the two clusters contribute (rows 1 and 2). Points
    // contribute nothing — the aggregated buffer is cluster-dense (one slot
    // per cluster row, packed contiguously; no slots for points).
    assert_eq!(agg.len(), 2, "two clusters * spec_len 1");
    assert_eq!(agg[0], 5.0, "cluster 100's value");
    assert_eq!(agg[1], 7.0, "cluster 101's value");
}

#[test]
fn lng_lat_round_trip_through_projection_at_encode_time() {
    // The encoder projects x/y back to lng/lat. For a point at a known lng/lat,
    // the encoded lng/lat must round-trip through lng_x/lat_y -> x_lng/y_lat.
    let lng = -79.04411780507252_f64;
    let lat = 43.08771393436908_f64;
    let f = point(0, lng, lat);
    let (rows, _, _) = encode_results(&[f], 0);
    let enc_lng = rows[0];
    let enc_lat = rows[1];
    // x_lng(lng_x(lng)) == lng to ~1e-9 (the projection is linear in x).
    assert!((enc_lng - lng).abs() < 1e-9, "lng round-trip: {enc_lng} vs {lng}");
    // y_lat(lat_y(lat)) == lat to ~1e-9 for moderate latitudes.
    assert!((enc_lat - lat).abs() < 1e-9, "lat round-trip: {enc_lat} vs {lat}");
    // And the inverse direction holds: projecting the encoded lng/lat forward
    // lands back on the stored x/y.
    let x = lng_x(enc_lng);
    let y = lat_y(enc_lat);
    assert!((x_lng(x) - enc_lng).abs() < 1e-12);
    assert!((y_lat(y) - enc_lat).abs() < 1e-12);
}
