//! Brute-force set-equality oracle: the spec's sub-seam A.
//!
//! `range`/`within` results must match an O(N) brute-force scan over the same
//! points — as *sets* (membership), not order. The spec (ticket 02) names this
//! the acceptance criterion: "range/within results match a brute-force bbox/
//! radius scan." This is the independent source of truth (not recomputed the
//! way the kd-tree does), complementing the exact-order fixture tests.
//!
//! Workload shape mirrors `refs/kdbush/bench.js`: integer coords in [0, 1000),
//! nodeSize 64. The small/medium cases run in the default suite; the 1M×10k
//! acceptance case is `#[ignore]`'d (brute force is O(N) per query).

use kdbush::KDBush;
use std::collections::HashSet;

/// Seeded xorshift32 PRNG — the same one `bench/datasets/generate.js` uses, so
/// the oracle's synthetic data is reproducible across the JS and Rust sides of
/// the project. Deterministic across machines; `Math.random` is deliberately
/// avoided.
struct Rng {
    state: u32,
}
impl Rng {
    fn new(seed: u32) -> Self {
        // xorshift32 cannot start at 0; remap, matching generate.js.
        let state = if seed == 0 { 0x9e3779b9 } else { seed };
        Self { state }
    }
    fn next_u32(&mut self) -> u32 {
        let mut s = self.state;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.state = s;
        s
    }
    /// Uniform integer in [0, max).
    fn random_int(&mut self, max: u32) -> u32 {
        self.next_u32() % max
    }
}

/// Build a kd-bush index over `n` random integer points in [0, 1000)².
fn build_index(n: usize, seed: u32, node_size: u32) -> (KDBush, Vec<[u32; 2]>) {
    let mut rng = Rng::new(seed);
    let mut points = Vec::with_capacity(n);
    for _ in 0..n {
        points.push([rng.random_int(1000), rng.random_int(1000)]);
    }
    let mut index = KDBush::new(n, node_size);
    for &[x, y] in &points {
        index.add(x as f32, y as f32);
    }
    index.finish().expect("finish");
    (index, points)
}

/// Brute-force bbox scan: every point id whose coords fall in [min,max] on both
/// axes. O(N); the independent oracle the kd-tree `range` is checked against.
fn brute_range(points: &[[u32; 2]], min_x: u32, min_y: u32, max_x: u32, max_y: u32) -> HashSet<u32> {
    points
        .iter()
        .enumerate()
        .filter(|(_, [x, y])| (min_x..=max_x).contains(x) && (min_y..=max_y).contains(y))
        .map(|(i, _)| i as u32)
        .collect()
}

/// Brute-force radius scan: every point id within `r` of `(qx, qy)`, by squared
/// distance (f64, matching the kd-tree's query arithmetic).
fn brute_within(points: &[[u32; 2]], qx: f64, qy: f64, r: f64) -> HashSet<u32> {
    let r2 = r * r;
    points
        .iter()
        .enumerate()
        .filter(|(_, [x, y])| {
            let dx = *x as f64 - qx;
            let dy = *y as f64 - qy;
            dx * dx + dy * dy <= r2
        })
        .map(|(i, _)| i as u32)
        .collect()
}

/// Assert the kd-tree's `range` result set equals the brute-force scan.
fn assert_range_matches(index: &KDBush, points: &[[u32; 2]], min_x: u32, min_y: u32, max_x: u32, max_y: u32) {
    let result = index
        .range(min_x as f64, min_y as f64, max_x as f64, max_y as f64)
        .expect("range");
    let expected = brute_range(points, min_x, min_y, max_x, max_y);
    let result_set: HashSet<u32> = result.iter().copied().collect();
    assert_eq!(result_set, expected, "range membership mismatch");
}

/// Assert the kd-tree's `within` result set equals the brute-force scan.
fn assert_within_matches(index: &KDBush, points: &[[u32; 2]], qx: f64, qy: f64, r: f64) {
    let result = index.within(qx, qy, r).expect("within");
    let expected = brute_within(points, qx, qy, r);
    let result_set: HashSet<u32> = result.iter().copied().collect();
    assert_eq!(result_set, expected, "within membership mismatch");
}

// ---------------------------------------------------------------------------
// Small + medium scale: always-on. Drives thousands of random queries through
// the kd-tree and brute force and asserts set equality on every one.
// ---------------------------------------------------------------------------

#[test]
fn range_matches_brute_force_small() {
    let (index, points) = build_index(500, 42, 64);
    let mut rng = Rng::new(123);
    for _ in 0..200 {
        let cx = rng.random_int(1000);
        let cy = rng.random_int(1000);
        let w = rng.random_int(50) + 1; // 1..50
        let h = rng.random_int(50) + 1;
        let min_x = cx.saturating_sub(w);
        let max_x = (cx + w).min(999);
        let min_y = cy.saturating_sub(h);
        let max_y = (cy + h).min(999);
        assert_range_matches(&index, &points, min_x, min_y, max_x, max_y);
    }
}

#[test]
fn within_matches_brute_force_small() {
    let (index, points) = build_index(500, 42, 64);
    let mut rng = Rng::new(456);
    for _ in 0..200 {
        let qx = rng.random_int(1000) as f64;
        let qy = rng.random_int(1000) as f64;
        let r = rng.random_int(50) as f64 + 1.0; // 1..50
        assert_within_matches(&index, &points, qx, qy, r);
    }
}

#[test]
fn range_and_within_match_brute_force_medium() {
    // 50k points, nodeSize 64 (the supercluster default). Exercises deeper
    // trees and larger leaf scans than the small case.
    let (index, points) = build_index(50_000, 7, 64);
    let mut rng = Rng::new(789);
    for _ in 0..200 {
        let cx = rng.random_int(1000);
        let cy = rng.random_int(1000);
        let w = rng.random_int(40) + 1;
        let h = rng.random_int(40) + 1;
        assert_range_matches(
            &index,
            &points,
            cx.saturating_sub(w),
            cy.saturating_sub(h),
            (cx + w).min(999),
            (cy + h).min(999),
        );
        assert_within_matches(
            &index,
            &points,
            cx as f64,
            cy as f64,
            rng.random_int(40) as f64 + 1.0,
        );
    }
}

#[test]
fn range_matches_brute_force_with_small_node_size() {
    // nodeSize 2 → deepest tree, most recursion; stresses the DFS stack and
    // the median partition. Distinct from the nodeSize-64 path above.
    let (index, points) = build_index(2000, 99, 2);
    let mut rng = Rng::new(321);
    for _ in 0..100 {
        let cx = rng.random_int(1000);
        let cy = rng.random_int(1000);
        let w = rng.random_int(60) + 1;
        let h = rng.random_int(60) + 1;
        assert_range_matches(
            &index,
            &points,
            cx.saturating_sub(w),
            cy.saturating_sub(h),
            (cx + w).min(999),
            (cy + h).min(999),
        );
    }
}

// ---------------------------------------------------------------------------
// Edge cases: the spec (User Story 9) requires graceful handling of empty
// sets, single points, and duplicate coordinates.
// ---------------------------------------------------------------------------

#[test]
fn empty_index_range_and_within_return_empty() {
    let mut index = KDBush::new(0, 64);
    index.finish().expect("finish");
    assert!(index.range(0.0, 0.0, 100.0, 100.0).unwrap().is_empty());
    assert!(index.within(50.0, 50.0, 10.0).unwrap().is_empty());
}

#[test]
fn single_point_index_matches_brute_force() {
    let mut index = KDBush::new(1, 64);
    index.add(500.0, 500.0);
    index.finish().expect("finish");
    let points = [[500u32, 500]];
    assert_range_matches(&index, &points, 0, 0, 999, 999);
    assert_range_matches(&index, &points, 600, 600, 700, 700); // misses
    assert_within_matches(&index, &points, 500.0, 500.0, 1.0); // hits
    assert_within_matches(&index, &points, 0.0, 0.0, 1.0); // misses
}

#[test]
fn all_duplicate_coordinates_cluster_correctly() {
    // 200 points all at the same coordinate. The kd-tree must still return all
    // of them for a query covering that coordinate (degenerate but valid).
    let n = 200;
    let mut index = KDBush::new(n, 64);
    for _ in 0..n {
        index.add(500.0, 500.0);
    }
    index.finish().expect("finish");
    let points: Vec<[u32; 2]> = vec![[500, 500]; n];
    assert_range_matches(&index, &points, 500, 500, 500, 500);
    assert_within_matches(&index, &points, 500.0, 500.0, 0.0); // r=0: distance 0 <= 0
    assert_within_matches(&index, &points, 499.0, 499.0, 2.0); // just outside r
}

#[test]
fn finish_rejects_underfull_index() {
    let mut index = KDBush::new(10, 64);
    index.add(0.0, 0.0);
    assert!(index.finish().is_err(), "underfull finish must error");
}

#[test]
fn finish_is_idempotent() {
    let mut index = KDBush::new(5, 64);
    for i in 0..5 {
        index.add(i as f32, i as f32);
    }
    index.finish().expect("first finish");
    // A second finish must not panic or re-sort; the index stays queryable.
    index.finish().expect("second finish (idempotent)");
    let r = index.range(0.0, 0.0, 4.0, 4.0).unwrap();
    assert_eq!(r.len(), 5);
}

#[test]
fn boundary_inclusive_range_and_within() {
    // Points exactly on the bbox/radius boundary are included (<=, >=), matching
    // refs/kdbush. This is the f64-arithmetic boundary contract ADR 0003 cares
    // about — the membership must not flip at the edge.
    let mut index = KDBush::new(4, 2);
    index.add(0.0, 0.0);
    index.add(10.0, 10.0);
    index.add(20.0, 20.0);
    index.add(30.0, 30.0);
    index.finish().expect("finish");
    let points = [[0u32, 0], [10, 10], [20, 20], [30, 30]];

    // range [0,10] inclusive: hits (0,0) and (10,10).
    assert_range_matches(&index, &points, 0, 0, 10, 10);
    // within r=10 of (0,0): distance to (10,10) is sqrt(200)≈14.1 > 10, so only (0,0).
    assert_within_matches(&index, &points, 0.0, 0.0, 10.0);
    // within r=14.142.. of (0,0): hits (0,0) and (10,10) (dist sqrt(200)).
    assert_within_matches(&index, &points, 0.0, 0.0, (200.0f64).sqrt());
}

// ---------------------------------------------------------------------------
// 1M×10k acceptance case — the spec's headline criterion. Ignored by default
// (brute force is O(N) per query; 10k queries × 1M points ≈ tens of seconds).
// Run with: cargo test --test brute_force -- --ignored million_points_acceptance
// ---------------------------------------------------------------------------

#[test]
#[ignore = "1M points × 10k brute-force queries (~tens of seconds); run on demand"]
fn million_points_acceptance() {
    let (index, points) = build_index(1_000_000, 42, 64);
    let mut rng = Rng::new(999);
    for _ in 0..10_000 {
        let cx = rng.random_int(1000);
        let cy = rng.random_int(1000);
        // Small bbox + small radius, matching refs/kdbush/bench.js's workload.
        assert_range_matches(
            &index,
            &points,
            cx.saturating_sub(1),
            cy.saturating_sub(1),
            (cx + 1).min(999),
            (cy + 1).min(999),
        );
        assert_within_matches(&index, &points, cx as f64, cy as f64, 1.0);
    }
}
