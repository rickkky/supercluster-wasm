//! Sub-seam B (ticket 07): the compact typed-array result encoding.
//!
//! The WASM↔JS boundary contract is "the typed array a WASM call returns decodes
//! to the expected id+coord+count+cluster/point-tag set for a given query"
//! (spec, Testing Decisions). The encoding is the part that matters, so it is
//! a pure-Rust function — testable with plain `cargo test`, no wasm32 target,
//! no `wasm-bindgen`. The FFI shell in `src/wasm.rs` is a thin caller that runs
//! this over a query's `Vec<ClusterFeature>` and hands the buffers to JS via a
//! zero-copy `Float64Array::view`.
//!
//! # Layout (Float64Array)
//!
//! Per the ADR 0003 f64-center amendment (`docs/adr/0003`), cluster centers are
//! unfrounded `f64` and `ClusterFeature.x/.y` are `f64`; aggregated values are
//! `f64` too. The spec's "Float32Array view" wording predates that amendment —
//! `Float64Array` preserves the precision ADR 0003 explicitly protects, and
//! `u32` ids/counts stored as `f64` are exact (below 2^53). `Float64Array::view`
//! is the same zero-copy mechanism as `Float32Array::view`.
//!
//! - **row buffer**, stride 5: `[lng, lat, id, num_points, tag]`
//!   - `lng`/`lat` = `x_lng`/`y_lat` of the feature's projected `[0..1]` x/y
//!   - `id` = `cluster_id` (Cluster) or `feature_id` (Point); `u32 as f64`
//!   - `num_points` = the cluster's count (Cluster) or `1` (Point); `u32 as f64`
//!   - `tag` = `0.0` (Point) | `1.0` (Cluster)
//! - **aggregated buffer**, stride `spec_len`: finalized values in spec order.
//!   Written only for clusters (points carry no aggregated values), packed
//!   contiguously one cluster after another. Empty when `spec_len == 0`.
//!
//! The aggregated buffer is cluster-dense (no slots for points) because points
//! never carry aggregated values — the JS decode side reads it in lockstep with
//! the row buffer, advancing the agg offset only on cluster rows.

use crate::projection::{x_lng, y_lat};
use crate::query::{ClusterFeature, FeatureKind};

/// Row stride in the row buffer: `[lng, lat, id, num_points, tag]`.
pub const ROW_STRIDE: usize = 5;
/// `tag` slot value for an unclustered source Point.
pub const TAG_POINT: f64 = 0.0;
/// `tag` slot value for a merged Cluster.
pub const TAG_CLUSTER: f64 = 1.0;

/// Encode a query's features into the compact typed-array contract.
///
/// Returns `(row_buf, agg_buf, count)`:
/// - `row_buf`: `count * ROW_STRIDE` f64 values.
/// - `agg_buf`: `(<#clusters>) * spec_len` f64 values (cluster-dense); empty if
///   `spec_len == 0`.
/// - `count`: the number of features (= rows).
///
/// See the module docs for the per-slot layout. The caller (the `wasm.rs` FFI
/// shell) stores these `Vec<f64>`s as the per-query buffer and returns
/// `Float64Array::view`s into them; the fresh allocation per call avoids
/// `Float64Array::view` aliasing UB across queries of different sizes.
#[must_use]
pub fn encode_results(features: &[ClusterFeature], spec_len: usize) -> (Vec<f64>, Vec<f64>, usize) {
    let count = features.len();
    let mut row_buf = Vec::with_capacity(count * ROW_STRIDE);
    // Upper bound on aggregated slots: at most one row per feature (clusters
    // only). Over-allocating is fine; the Vec is drained to exact length by
    // the time we return (we push exactly the cluster rows' values).
    let mut agg_buf = Vec::with_capacity(count.saturating_mul(spec_len));

    for f in features {
        let lng = x_lng(f.x);
        let lat = y_lat(f.y);
        row_buf.push(lng);
        row_buf.push(lat);
        match &f.kind {
            FeatureKind::Point { feature_id } => {
                row_buf.push(f64::from(*feature_id));
                row_buf.push(1.0); // a point represents exactly one source point
                row_buf.push(TAG_POINT);
            }
            FeatureKind::Cluster { cluster_id, num_points, aggregated } => {
                row_buf.push(f64::from(*cluster_id));
                row_buf.push(f64::from(*num_points));
                row_buf.push(TAG_CLUSTER);
                if spec_len > 0 {
                    // `aggregated` is in spec order (ticket 06 surfaces values
                    // per spec field). Pad/truncate to `spec_len` defensively:
                    // a well-formed index surfaces exactly `spec_len` values,
                    // but the encoder must not panic if a row is short.
                    for j in 0..spec_len {
                        let v = aggregated.get(j).map(|(_, v)| *v).unwrap_or(0.0);
                        agg_buf.push(v);
                    }
                }
            }
        }
    }

    debug_assert_eq!(row_buf.len(), count * ROW_STRIDE);
    (row_buf, agg_buf, count)
}
