//! Generated-dataset cross-checks against JS supercluster, plus projection
//! round-trip tests. The generated datasets use the same seeded xorshift32 PRNG
//! as `bench/datasets/generate.js` (see `tests/common/mod.rs`), so the Rust
//! build runs over byte-identical inputs to the JS oracle — and the per-zoom
//! top-level counts must match JS supercluster's exactly.
//!
//! The projection tests pin the f32 spherical-mercator projection (ADR 0003):
//! `lng_x`/`lat_y` must match supercluster's `lngX`/`latY` bit-for-bit after
//! `fround`, so the stored coordinates — and thus the radius-query pruning
//! boundaries — are directly comparable to the reference.

mod common;

use supercluster::supercluster::Supercluster;

/// JS supercluster's top-level entry count per zoom `[0..7]` for
/// `uniformRandom(1000, 42)` with `maxZoom: 6`.
const UNIFORM_1000_42: [u32; 8] = [70, 220, 505, 795, 943, 983, 993, 1000];

/// JS supercluster's top-level entry count per zoom `[0..7]` for
/// `clusteredSynthetic(1000, 42, loadCenters())` with `maxZoom: 6`.
///
/// Captured fresh from `refs/supercluster/index.js` over a byte-identical
/// dataset (the Rust generator's output matches JS's coordinate-for-coordinate;
/// see `clustered_dump_first20_coords`'s removed diagnostic). The clustered
/// dataset includes antimeridian-wrapped points (lng > 180 from a Gaussian
/// offset off a near-180° center), which project to x > 1.0 — these cluster
/// normally and are counted here; they only drop out of `getClusters` viewport
/// extraction (a ticket-04 concern), not the lattice count.
const CLUSTERED_1000_42: [u32; 8] = [34, 64, 108, 218, 469, 737, 910, 1000];

fn assert_counts_match(points: &[supercluster::feature::PointFeature], expected: [u32; 8]) {
    let index = Supercluster::load(points.to_vec(), common::oracle_options());
    for z in 0..=7 {
        let lattice = index.stack.get(z).unwrap_or_else(|| panic!("z={z} lattice"));
        assert_eq!(
            lattice.len(),
            expected[z as usize] as usize,
            "z={z}: count {} != JS supercluster's {}",
            lattice.len(),
            expected[z as usize]
        );
    }
}

#[test]
fn uniform_1000_seed_42_counts_match_js_supercluster() {
    let points = common::uniform_random(1000, 42);
    assert_counts_match(&points, UNIFORM_1000_42);
}

#[test]
fn clustered_1000_seed_42_counts_match_js_supercluster() {
    let points = common::clustered_synthetic(1000, 42);
    assert_counts_match(&points, CLUSTERED_1000_42);
}

// Projection round-trip and fround-semantics tests live in the `projection`
// module's own unit tests (`src/projection.rs`), not here: the integration
// layer adds no coverage the unit tests don't, and duplicating them would
// be maintenance noise. This file's job is the JS-supercluster count
// cross-check, which only the integration harness can run (it needs the
// seeded dataset generators + the full build pipeline).
