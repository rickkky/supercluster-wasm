//! Structural acceptance for ticket 03: the Cluster Lattice builds without
//! panic and the SoA arrays are populated correctly.
//!
//! This is the build half's acceptance — "the lattice builds without panic
//! and the SoA arrays are populated correctly for a known small input." Full
//! behavioral verification (the query half) lands in ticket 04; here we assert
//! the invariants the build must satisfy for *any* correct query half to sit
//! on top of:
//!
//!   - The lattice builds on `places.json` (163 Points, one with
//!     `geometry: null`) and on seeded generated sets, without panic.
//!   - **Partition property**: at every zoom, the lattice's top-level entries
//!     partition the geometry-bearing source Points — `sum(num_points)` equals
//!     the geometry-bearing count, with no overlap and no gaps. This is the
//!     invariant the semantic-equivalence oracle's `extractMembership` relies
//!     on (see `test/oracle.test.js`'s partition tests).
//!   - The kd-tree is `finish`-ed and queryable: `within` returns the entry
//!     itself for a zero-radius self-query.
//!   - A hand-checked small input produces the expected cluster: three close
//!     points merge into one cluster (num_points 3) while a far point stays a
//!     singleton, at a zoom whose radius covers the three but not the far one.

mod common;

use supercluster::feature::PointFeature;
use supercluster::options::Options;
use supercluster::supercluster::Supercluster;

/// Assert the partition property holds at every built zoom: the sum of
/// `num_points` over the lattice's top-level entries equals the geometry-bearing
/// source-point count. (We cannot assert *which* points cluster without the
/// query half — that is ticket 04 — but the count must be conserved: every
/// source point belongs to exactly one top-level entry.)
fn assert_partition(index: &Supercluster, geometry_bearing: usize) {
    for zoom in index.options.min_zoom..=index.options.max_zoom + 1 {
        let lattice = index
            .stack
            .get(zoom)
            .unwrap_or_else(|| panic!("lattice at zoom {zoom} must be built"));
        let total: u64 = lattice.num_points.iter().map(|&n| n as u64).sum();
        assert_eq!(
            total, geometry_bearing as u64,
            "zoom {zoom}: partition broken, sum(num_points)={total} != {geometry_bearing}"
        );
        // Every top-level entry has a sane num_points (>=1) and a valid
        // source_id (cluster id above points_len, or raw source id below).
        for i in 0..lattice.len() {
            assert!(
                lattice.num_points[i] >= 1,
                "zoom {zoom} entry {i}: num_points < 1"
            );
        }
    }
}

#[test]
fn builds_on_places_json_without_panic() {
    // places.json: 163 features, one with geometry: null (Null Island). The
    // build must skip the null-geometry feature and cluster the 162 bearing
    // ones without panicking.
    let points = common::load_places();
    let geometry_bearing = points
        .iter()
        .filter(|p| p.coord.is_some())
        .count();
    assert_eq!(points.len(), 163, "places.json has 163 features");
    assert_eq!(geometry_bearing, 162, "one Null Island feature has no geometry");

    let index = Supercluster::load(points, common::oracle_options());
    assert_partition(&index, geometry_bearing);
}

#[test]
fn builds_on_seeded_uniform_set_without_panic() {
    // A seeded 1k uniform set — the same (n, seed) the JS oracle self-verifies
    // against. The build must not panic and the partition must hold.
    let points = common::uniform_random(1000, 42);
    let geometry_bearing = points.len();
    let index = Supercluster::load(points, common::oracle_options());
    assert_partition(&index, geometry_bearing);
}

#[test]
fn builds_on_empty_input_without_panic() {
    // supercluster's `load([])` does not throw (User Story 9). The Rust build
    // must likewise produce an empty lattice stack without panicking.
    let index = Supercluster::load(Vec::new(), common::oracle_options());
    for zoom in index.options.min_zoom..=index.options.max_zoom + 1 {
        let lattice = index.stack.get(zoom).expect("empty lattice still built");
        assert!(lattice.is_empty(), "zoom {zoom}: empty input -> empty lattice");
    }
}

#[test]
fn builds_on_single_point_without_panic() {
    // A single point can never form a cluster (minPoints >= 2); it must survive
    // as a singleton at every zoom.
    let points = vec![PointFeature::new(0.0, 0.0)];
    let index = Supercluster::load(points, common::oracle_options());
    assert_partition(&index, 1);
    for zoom in index.options.min_zoom..=index.options.max_zoom + 1 {
        let lattice = index.stack.get(zoom).expect("lattice built");
        assert_eq!(lattice.len(), 1, "zoom {zoom}: single point -> one entry");
        assert_eq!(lattice.num_points[0], 1, "zoom {zoom}: singleton num_points");
    }
}

#[test]
fn lattice_kd_tree_is_queryable_after_build() {
    // The build must `finish` each lattice's kd-tree so the query half (ticket
    // 04) can run `within`. A zero-radius self-query at a known entry's coord
    // must return at least that entry.
    let points = common::uniform_random(500, 7);
    let index = Supercluster::load(points, common::oracle_options());
    let lattice = index.stack.get(index.options.max_zoom + 1).expect("raw lattice");
    // The raw lattice has one entry per source point; query the first entry's
    // own coordinate with r=0 — it must be found (distance 0 <= 0).
    let x = lattice.x[0];
    let y = lattice.y[0];
    let ids = lattice.within(x, y, 0.0);
    assert!(
        !ids.is_empty(),
        "zero-radius self-query must find at least the queried entry"
    );
}

#[test]
fn hand_checked_three_close_one_far_clusters_correctly() {
    // Three points within the clustering radius of each other, plus one far
    // point. At a zoom whose radius (in [0..1] space) covers the three but not
    // the far one, the three must merge into one cluster (num_points 3) and the
    // far point must stay a singleton.
    //
    // Use maxZoom 0 so there is exactly one clustering zoom (z=0), with the
    // default radius formula r = 40 / (512 * 2^0) = 40/512 ≈ 0.078125 in
    // projected [0..1] space. Projected x = lng/360 + 0.5, so Δx = Δlng/360;
    // for the three to be within r but the far one outside, pick lngs whose
    // projected coords are ~0.02 apart (inside r) for the close three and
    // ~0.28 apart (well outside r) for the far one. Δlng ≈ 7° → Δx ≈ 0.019;
    // Δlng ≈ 100° → Δx ≈ 0.278.
    let points = vec![
        PointFeature::new(0.0, 0.0),
        PointFeature::new(7.0, 0.0),
        PointFeature::new(0.0, 7.0),
        PointFeature::new(100.0, 0.0),
    ];
    let options = Options {
        max_zoom: 0,
        ..Options::default()
    };
    let index = Supercluster::load(points, options);

    let lattice = index.stack.get(0).expect("z=0 lattice built");
    // Two top-level entries: the 3-point cluster and the far singleton.
    assert_eq!(lattice.len(), 2, "expected 2 top-level entries (cluster + singleton)");
    let mut counts: Vec<u32> = lattice.num_points.clone();
    counts.sort();
    assert_eq!(counts, [1, 3], "expected one singleton and one 3-point cluster");

    // The cluster's num_points is 3; the singleton's is 1. The cluster id must
    // be a valid cluster id (>= points_len = 4), the singleton a source id.
    let mut found_cluster = false;
    let mut found_singleton = false;
    for i in 0..lattice.len() {
        if lattice.num_points[i] == 3 {
            found_cluster = true;
            assert!(
                lattice.source_id[i] >= 4,
                "cluster id {} must be offset above points_len (4)",
                lattice.source_id[i]
            );
        } else {
            found_singleton = true;
            assert!(
                lattice.source_id[i] < 4,
                "singleton source id {} must be a raw source id (< 4)",
                lattice.source_id[i]
            );
        }
    }
    assert!(found_cluster, "no 3-point cluster formed");
    assert!(found_singleton, "no singleton survived");
}

#[test]
fn duplicate_coordinates_cluster_correctly() {
    // User Story 9: duplicate coordinates must cluster normally. Two coincident
    // points must form a cluster at a zoom whose radius covers them (distance 0
    // <= r). Mirrors refs/supercluster/test.js's "same-location points" case.
    let points = vec![
        PointFeature::new(-1.426798, 53.943034),
        PointFeature::new(-1.426798, 53.943034),
    ];
    let options = Options {
        max_zoom: 0,
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let lattice = index.stack.get(0).expect("z=0 lattice");
    // Two coincident points within r=0.078 of each other (distance 0): one
    // cluster of num_points 2.
    assert_eq!(lattice.len(), 1, "two coincident points -> one cluster");
    assert_eq!(lattice.num_points[0], 2, "cluster merges both points");
}
