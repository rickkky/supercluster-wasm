# 06 — Declarative aggregation spec (sum/count/min/max/mean)

**What to build:** Replaces JS `reduce`/`map` callbacks (removed for performance — they would force per-Point JS↔WASM boundary chatter during build) with a declarative aggregation spec over named Point properties covering sum, count, min, max, and mean, computed in Rust during the `_cluster` build pass. Adds aggregation accumulator arrays to the SoA internal layout (alongside numPoints, same lifecycle). Clusters without a spec carry `point_count` and its abbreviated form only. The aggregated properties surface in `getClusters` results. Verified behaviorally through `getClusters` against `test.js`'s `map`/`reduce` `scalerank`-sum case (adapted from getTile to getClusters): the Rust version produces the same per-Cluster sums as JS supercluster's reduce. Custom aggregation needs not covered by the spec fall back to `getLeaves` + JS-side computation.

**Blocked by:** 04 (getClusters query, oracle-verified) — aggregation surfaces in and is verified through getClusters results.

**Status:** resolved

- [x] Declarative aggregation spec accepts named-property operations (sum/count/min/max/mean)
- [x] Aggregation computed in Rust during the build pass; accumulator arrays added to SoA layout
- [x] Aggregated properties surface in `getClusters` Cluster results
- [x] Clusters without a spec carry `point_count` and abbreviated form only
- [x] Per-Cluster sums match JS supercluster's `reduce` on the `scalerank` test case

## Answer

Implemented declarative aggregation (sum/count/min/max/mean) in the
`supercluster` crate, replacing JS `map`/`reduce` callbacks with a Rust-side
fold so the build pass never crosses the JS↔WASM boundary per point.

- **Spec types** (`src/aggregation.rs`): `AggOp` (Sum/Count/Min/Max/Mean),
  `AggField { name, prop, op }`, `AggSpec` builder (`AggregationSpec::new()
  .with(name, prop, op)`, `&'static str` keys — no lifetime threading),
  `AggState { op, value, count }` with `identity`/`from_value`/`combine`/
  `value`. Mean is count-weighted: tracked as (sum, count), `combine` adds
  both, `value()` returns sum/count — so sub-cluster means fold correctly
  (not naively averaged). Algebra is identity-neutral + associative, pinned
  by `tests/aggregation.rs` (5 unit tests).
- **Sidecar, not JSON parsing** (preserves serde-free release lib):
  `PointFeature` gained `numeric_props: Vec<(String, f64)>`, populated at the
  WASM boundary / fixture loaders (`datasets.rs`, `tests/common/mod.rs`
  extract `scalerank`), not parsed in the build loop. `Options` gained
  `spec: AggregationSpec` (lost `Copy` — all `..Default()` call sites still
  compile).
- **SoA accumulators** (`src/lattice.rs`): `Lattice` gained
  `acc: Vec<AggState>` + `acc_stride`; `push_point_from` copies the acc row,
  `push_cluster` takes a folded `Vec<AggState>`, `raw_from_coords` seeds acc
  from each bearing point's `get_numeric(prop)` per spec field. `acc_row(i)`
  exposes the row.
- **Hierarchical fold** (`src/supercluster.rs::cluster`): each new cluster's
  acc row starts as the origin point's acc, then folds each absorbed child's
  acc (`acc_row[idx] = acc_row[idx].combine(*child_state)`). Sub-clusters
  contribute their own already-folded state (not re-mapped) — matches JS
  supercluster's `reduce(origin.map, Σ children.map)` exactly.
- **Surfacing** (`src/query.rs::feature_at`): each Cluster's `aggregated`
  field is `spec.iter().zip(lattice.acc_row(i)).map(|(f, s)| (f.name, s.value()))`.
  No-spec clusters get an empty `aggregated` (carry `point_count` only).
- **Fixture-pinned oracle** (option A, mirroring 04): `bench/oracle/
  capture-aggregates.js` builds JS supercluster with
  `map: p => ({sum: p.scalerank})` / `reduce: (a,b) => {a.sum += b.sum}` over
  `places.json` (radius 100, maxZoom 16 — `test.js`'s config) and captures
  each Cluster's `sum` keyed by `cluster_id` per zoom via whole-world
  `getClusters`. `tests/aggregates.rs` builds Rust with the same
  `sum(scalerank)` spec + radius/maxZoom and asserts per-cluster sum equality
  keyed by `cluster_id` (ADR 0004: ids are numerically interchangeable, no
  translation layer). 3 tests: primary match, no-spec-emptiness guard,
  anti-tautology (radius 40 vs 100 must differ).

77 Rust tests pass (74 prior + 3 new), 30 JS tests pass. No-spec path is
byte-for-byte the old shape (no membership-equivalence regression). WASM
boundary population of `numeric_props` is ticket 07.
