//! Declarative aggregation spec (ticket 06).
//!
//! Replaces JS supercluster's `reduce`/`map` callbacks — removed for
//! performance, since they would force per-Point JS↔WASM boundary chatter
//! during the build pass — with a declarative spec over named Point
//! properties covering sum, count, min, max, and mean, computed in Rust
//! during the `_cluster` build pass.
//!
//! The spec is a builder of named outputs: `AggregationSpec::new().with(name,
//! prop, op)`. Each output names the key it surfaces under in `getClusters`
//! Cluster results (mirroring JS's `map: props => ({sum: props.scalerank})`,
//! which names the output `sum`). A spec with no outputs is the "no spec"
//! common case: clusters carry `point_count` (and its abbreviated form) only.
//!
//! The fold is **hierarchical**, matching JS supercluster's `reduce` exactly:
//! a new cluster's accumulated state = the origin point's mapped state
//! combined with each absorbed child's accumulated state (a sub-cluster
//! contributes its *own* accumulated state, not a re-mapped leaf value). So
//! `cluster.sum = Σ leaf scalerank`, identical to JS's
//! `reduce: (a, b) => { a.sum += b.sum }` where `b` is a sub-cluster's
//! already-reduced props. The combine operation's algebra (identity-neutral,
//! associative) is what makes the hierarchical fold correct; it is pinned in
//! `tests/aggregation.rs`.
//!
//! This module is pure types — no JSON, no lattice. The build loop
//! (`supercluster.rs`) folds [`AggState`]s; the query half (`query.rs`)
//! finalizes them (mean = sum/count) and surfaces them in `ClusterFeature`.

use std::sync::Arc;

/// One aggregation operation. Covers sum/count/min/max/mean over a named
/// Point property, the set the spec (ticket 06) calls out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggOp {
    /// `Σ prop` over the cluster's leaves.
    Sum,
    /// Number of leaves carrying the property (not `Σ prop`).
    Count,
    /// Minimum `prop` among the cluster's leaves.
    Min,
    /// Maximum `prop` among the cluster's leaves.
    Max,
    /// `Σ prop / count` — the arithmetic mean. Internally tracked as
    /// `(sum, count)` so sub-cluster means combine count-weighted (not
    /// naively averaged), matching JS `reduce` over `map:{sum,count}`.
    Mean,
}

/// One named output of the spec: surface `op(prop)` under `name` in
/// `getClusters` Cluster results.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AggField {
    /// The key the aggregated value surfaces under (JS's `map` output name).
    pub name: &'static str,
    /// The source Point property name to read.
    pub prop: &'static str,
    /// The aggregation operation.
    pub op: AggOp,
}

/// The declarative aggregation spec: a list of named outputs.
///
/// Built with [`AggregationSpec::new`] + [`AggregationSpec::with`]. Lives on
/// [`Options`](crate::options::Options) as `Option<AggregationSpec>` (a
/// cluster with no spec carries `point_count` only). Held in an `Arc` so an
/// `Options` (which is `Clone`) shares the field list cheaply rather than
/// cloning the slice per copy.
///
/// `&'static str` keys: the spec is built at config time from string literals
/// (the property names a map developer names), so it never owns dynamic
/// strings. This keeps the spec `Copy`-cheap and avoids a lifetime threading
/// the whole way down to the build loop.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AggregationSpec {
    fields: Arc<Vec<AggField>>,
}

impl AggregationSpec {
    /// An empty spec — the "no spec" case: clusters carry `point_count` only.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one named output: surface `op(prop)` under `name`. Builder
    /// style; returns a new spec (the field list is shared via `Arc`, so this
    /// is cheap until the first mutation after a `clone`).
    #[must_use]
    pub fn with(mut self, name: &'static str, prop: &'static str, op: AggOp) -> Self {
        // Arc::make_mut clones the field list only if another spec shares it;
        // a fresh builder chain owns the sole Arc, so this is in-place.
        Arc::make_mut(&mut self.fields).push(AggField { name, prop, op });
        self
    }

    /// Iterate the named outputs, in registration order.
    pub fn iter(&self) -> impl Iterator<Item = AggField> + '_ {
        self.fields.iter().copied()
    }

    /// The number of named outputs.
    #[must_use]
    pub fn len(&self) -> usize {
        self.fields.len()
    }

    /// Whether the spec is empty (the "no spec" case).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

/// The per-op fold state for one cluster accumulator. One [`AggState`] per
/// spec field per lattice entry, stored in the SoA layout alongside
/// `num_points` (same lifecycle).
///
/// The state is the minimal carrier for its op's combine algebra:
/// - `Sum`/`Count`/`Min`/`Max`: a single `value` (Count's value is the leaf
///   count, not `Σ prop`).
/// - `Mean`: a `(sum, count)` pair, so sub-cluster means combine
///   count-weighted. `value()` returns `sum / count`.
///
/// `value()` is the finalized number the query half surfaces. For all ops
/// except `Mean` it is the stored value; for `Mean` it is the quotient.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AggState {
    op: AggOp,
    /// The folded value (for Mean: the running sum).
    value: f64,
    /// For Mean: the leaf count the sum is over. Unused by other ops.
    count: u32,
}

impl AggState {
    /// The identity element for `op` — neutral under [`combine`](Self::combine).
    /// The fold starts here; a cluster whose origin contributes nothing folds
    /// to the union of its children's states (or identity, if none).
    #[must_use]
    pub fn identity(op: AggOp) -> Self {
        match op {
            // Sum's identity is 0; Min's is +inf (any real value is smaller);
            // Max's is -inf. Count's identity is 0 (no values counted).
            AggOp::Sum | AggOp::Count => Self { op, value: 0.0, count: 0 },
            AggOp::Min => Self { op, value: f64::INFINITY, count: 0 },
            AggOp::Max => Self { op, value: f64::NEG_INFINITY, count: 0 },
            // Mean's identity is (sum=0, count=0); value() guards divide-by-0.
            AggOp::Mean => Self { op, value: 0.0, count: 0 },
        }
    }

    /// The state from a single mapped leaf value (the leaf's `prop`).
    /// For Mean, this is `(value, 1)` — one leaf contributing one count.
    #[must_use]
    pub fn from_value(op: AggOp, v: f64) -> Self {
        match op {
            AggOp::Sum | AggOp::Min | AggOp::Max => Self { op, value: v, count: 0 },
            AggOp::Count => Self { op, value: 1.0, count: 0 },
            AggOp::Mean => Self { op, value: v, count: 1 },
        }
    }

    /// Combine two states of the same op (associative; identity-neutral).
    /// This is the fold operation the build loop applies: origin's state
    /// combined with each absorbed child's accumulated state.
    ///
    /// `self` absorbs `other` (the caller's order is origin-then-children,
    /// matching JS's `reduce(acc, b)`; associativity makes the order not
    /// matter for the result).
    #[must_use]
    pub fn combine(mut self, other: Self) -> Self {
        debug_assert_eq!(self.op, other.op, "combine: op mismatch");
        match self.op {
            AggOp::Sum | AggOp::Count => self.value += other.value,
            AggOp::Min => self.value = self.value.min(other.value),
            AggOp::Max => self.value = self.value.max(other.value),
            AggOp::Mean => {
                // Count-weighted: (s1 + s2) / (c1 + c2). The sum and count
                // both accumulate, so a sub-cluster's mean weights by its
                // leaf count — not a naive average of means.
                self.value += other.value;
                self.count += other.count;
            }
        }
        self
    }

    /// The finalized value to surface in `getClusters`. For Mean, `sum /
    /// count` (0 if no leaves, avoiding divide-by-zero). For other ops, the
    /// stored value.
    #[must_use]
    pub fn value(&self) -> f64 {
        match self.op {
            AggOp::Mean if self.count == 0 => 0.0,
            AggOp::Mean => self.value / f64::from(self.count),
            _ => self.value,
        }
    }

    /// The op this state is for (the build loop keys a state to its field).
    #[must_use]
    pub fn op(&self) -> AggOp {
        self.op
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_round_trip() {
        let spec = AggregationSpec::new()
            .with("sum", "scalerank", AggOp::Sum)
            .with("mean", "scalerank", AggOp::Mean);
        let collected: Vec<AggField> = spec.iter().collect();
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].name, "sum");
        assert_eq!(collected[0].op, AggOp::Sum);
        assert_eq!(collected[1].name, "mean");
    }

    #[test]
    fn mean_value_is_sum_over_count() {
        let s = AggState::from_value(AggOp::Mean, 10.0).combine(AggState::from_value(AggOp::Mean, 20.0));
        // (10 + 20) / 2 = 15
        assert!((s.value() - 15.0).abs() < 1e-12);
    }

    #[test]
    fn mean_zero_count_is_zero_not_nan() {
        // Identity mean (no leaves) surfaces as 0, not NaN — guards the
        // divide-by-zero the query half would hit for an empty cluster.
        assert_eq!(AggState::identity(AggOp::Mean).value(), 0.0);
    }
}
