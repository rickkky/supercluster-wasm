//! Declarative aggregation spec (ticket 06): the pure types.
//!
//! Tests the spec/operation/state types in isolation — no build loop, no
//! lattice, no JSON. The build-loop folding and `get_clusters` surfacing are
//! exercised by the integration tests (`tests/aggregates.rs`); this file pins
//! the type-level contract: the builder shape, the operation enum's coverage
//! of sum/count/min/max/mean, and the per-op fold state's identity and
//! combine semantics (the two operations that must be correct for the
//! hierarchical fold to match JS supercluster's `reduce`).

use supercluster::aggregation::{AggOp, AggregationSpec};

#[test]
fn builder_registers_named_outputs_in_order() {
    // The spec is a builder: each `.with(name, prop, op)` registers one named
    // output. JS's `map: props => ({sum: props.scalerank})` names the output
    // `sum`; the spec mirrors that naming so per-cluster sums surface under
    // the same key the JS reduce would produce.
    let spec = AggregationSpec::new()
        .with("sum", "scalerank", AggOp::Sum)
        .with("count", "scalerank", AggOp::Count)
        .with("min", "scalerank", AggOp::Min)
        .with("max", "scalerank", AggOp::Max)
        .with("mean", "scalerank", AggOp::Mean);
    let names: Vec<&str> = spec.iter().map(|f| f.name).collect();
    assert_eq!(names, ["sum", "count", "min", "max", "mean"]);
    let ops: Vec<AggOp> = spec.iter().map(|f| f.op).collect();
    assert_eq!(ops, [AggOp::Sum, AggOp::Count, AggOp::Min, AggOp::Max, AggOp::Mean]);
}

#[test]
fn empty_spec_is_empty() {
    // A spec with no outputs: clusters carry `point_count` only. This is the
    // "no spec" common case (User Story 8).
    let spec = AggregationSpec::new();
    assert_eq!(spec.iter().count(), 0);
}

#[test]
fn op_identity_is_neutral_for_combine() {
    // The fold's identity element: combining a state with its identity must
    // leave the state unchanged. This is the algebraic property the
    // hierarchical fold relies on — a cluster with one contributing point
    // (origin only) must equal that point's mapped value, which only holds if
    // the identity is neutral.
    use supercluster::aggregation::AggState;
    for op in [AggOp::Sum, AggOp::Count, AggOp::Min, AggOp::Max, AggOp::Mean] {
        let id = AggState::identity(op);
        let one = AggState::from_value(op, 7.0);
        let combined = one.clone().combine(id);
        assert!(
            combined.value() == one.value(),
            "{op:?}: identity not neutral (one={}, combined={})",
            one.value(),
            combined.value()
        );
    }
}

#[test]
fn op_combine_matches_arithmetic() {
    // The combine operation must match the per-op arithmetic, since the build
    // loop folds origin + every child's accumulated state via `combine`. For
    // a two-point cluster, the result must equal folding the two leaves
    // directly.
    use supercluster::aggregation::AggState;
    let cases: &[(AggOp, f64, f64, f64)] = &[
        (AggOp::Sum, 3.0, 4.0, 7.0),
        (AggOp::Count, 3.0, 4.0, 2.0), // count of values, not their sum
        (AggOp::Min, 3.0, 4.0, 3.0),
        (AggOp::Max, 3.0, 4.0, 4.0),
        // mean of [3,4] = 3.5
        (AggOp::Mean, 3.0, 4.0, 3.5),
    ];
    for (op, a, b, expected) in cases {
        let sa = AggState::from_value(*op, *a);
        let sb = AggState::from_value(*op, *b);
        let got = sa.combine(sb.clone()).value();
        assert!(
            (got - expected).abs() < 1e-12,
            "{op:?}: combine({a}, {b}) = {got}, expected {expected}"
        );
    }
}

#[test]
fn mean_combines_as_weighted_not_naive() {
    // Mean is the trap: combining two means must be count-weighted, not a
    // naive average of means. mean([1,2,3]=2) combined with mean([10]=10) is
    // (1+2+3+10)/4 = 4, not (2+10)/2 = 6. The hierarchical fold relies on
    // this: a sub-cluster's accumulated mean must weight by its point count.
    use supercluster::aggregation::AggState;
    let a = AggState::from_value(AggOp::Mean, 1.0);
    // Build a 3-point mean of 2.0 by combining 1,2,3.
    let three = AggState::from_value(AggOp::Mean, 2.0)
        .combine(AggState::from_value(AggOp::Mean, 3.0))
        .combine(AggState::from_value(AggOp::Mean, 1.0));
    let combined = a.clone().combine(three);
    // (1 + 2 + 3 + 1) / 4 = 1.75  [a contributes {1}, three contributes {1,2,3}]
    assert!(
        (combined.value() - 1.75).abs() < 1e-12,
        "weighted mean: got {}",
        combined.value()
    );
}
