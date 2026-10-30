//! Option-semantics tests: the radius/extent/minPoints/maxZoom/nodeSize
//! defaults and the radius formula match supercluster, and changing them
//! changes clustering the way supercluster's semantics dictate.
//!
//! The defaults and formula are pinned in `options.rs`; here we assert the
//! *behavioral* consequences — that minPoints raises the cluster threshold,
//! that a larger radius merges more, and that maxZoom bounds the clustering
//! zooms — so an option-semantics drift is caught as a behavioral change, not
//! just a constant mismatch.

mod common;

use supercluster::feature::PointFeature;
use supercluster::options::Options;
use supercluster::supercluster::Supercluster;

/// Five points in a tight cluster (all within r at z=0 with default options),
/// plus one far singleton.
fn tight_cluster_plus_far() -> Vec<PointFeature> {
    vec![
        PointFeature::new(0.0, 0.0),
        PointFeature::new(5.0, 0.0),
        PointFeature::new(0.0, 5.0),
        PointFeature::new(5.0, 5.0),
        PointFeature::new(2.5, 2.5),
        PointFeature::new(100.0, 0.0),
    ]
}

#[test]
fn min_points_five_keeps_tight_group_unclustered_when_under_threshold() {
    // With minPoints=5, the five tight points (which would form one cluster
    // under default minPoints=2) still cluster — there are 5 of them, meeting
    // the threshold. The far point stays a singleton. So z=0 has 2 top-level
    // entries: the 5-point cluster and the singleton.
    let points = tight_cluster_plus_far();
    let options = Options {
        max_zoom: 0,
        min_points: 5,
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let lattice = index.stack.get(0).expect("z=0 lattice");
    assert_eq!(lattice.len(), 2, "5 tight points cluster + 1 singleton");
    let mut counts: Vec<u32> = lattice.num_points.clone();
    counts.sort();
    assert_eq!(counts, [1, 5]);
}

#[test]
fn min_points_six_prevents_the_tight_cluster_from_forming() {
    // With minPoints=6, the five tight points do NOT meet the threshold (only
    // 5 < 6), so they stay as 5 singletons; the far point is a 6th singleton.
    // z=0 has 6 top-level entries, all num_points 1.
    let points = tight_cluster_plus_far();
    let options = Options {
        max_zoom: 0,
        min_points: 6,
        ..Options::default()
    };
    let index = Supercluster::load(points, options);
    let lattice = index.stack.get(0).expect("z=0 lattice");
    assert_eq!(lattice.len(), 6, "no cluster forms under minPoints=6");
    for i in 0..lattice.len() {
        assert_eq!(lattice.num_points[i], 1, "entry {i} should be a singleton");
    }
}

#[test]
fn larger_radius_merges_more_points() {
    // Same five tight points + far singleton. With default radius (40) at
    // z=0, the five merge into one cluster (2 entries: cluster + singleton).
    // With a much larger radius, the far point is pulled in too → 1 entry
    // (a 6-point cluster). This is the anti-tautology guard for options: a
    // radius change MUST change the clustering.
    let points = tight_cluster_plus_far();

    let small = Supercluster::load(
        points.clone(),
        Options {
            max_zoom: 0,
            radius: 40.0,
            ..Options::default()
        },
    );
    let large = Supercluster::load(
        points,
        Options {
            max_zoom: 0,
            // radius large enough that r = radius/512 covers the projected
            // distance to the far point (Δx ≈ 100/360 ≈ 0.278). Need r > 0.278,
            // so radius > 0.278 * 512 ≈ 142. Use 200.
            radius: 200.0,
            ..Options::default()
        },
    );
    let small_lat = small.stack.get(0).expect("z=0");
    let large_lat = large.stack.get(0).expect("z=0");
    assert_eq!(small_lat.len(), 2, "default radius: 5-point cluster + singleton");
    assert_eq!(large_lat.len(), 1, "large radius: all 6 points merge");
    assert_eq!(large_lat.num_points[0], 6, "large radius: 6-point cluster");
}

#[test]
fn max_zoom_bounds_the_clustering_zooms() {
    // maxZoom is the highest clustering zoom. With maxZoom=0, only z=0 is
    // clustered; z=1 (maxZoom+1) is the raw lattice. With maxZoom=2, z=2 is
    // the highest clustered zoom and z=3 is raw.
    let points = common::uniform_random(200, 11);
    let index = Supercluster::load(
        points,
        Options {
            max_zoom: 2,
            ..Options::default()
        },
    );
    // Zooms 0, 1, 2 are clustered; 3 is raw (== source count).
    for z in 0..=2 {
        assert!(index.stack.get(z).is_some(), "z={z} clustered lattice built");
    }
    let raw = index.stack.get(3).expect("raw lattice at maxZoom+1=3");
    assert_eq!(raw.len(), 200, "raw lattice has one entry per source point");
    // Zoom 4 was never built (above maxZoom+1).
    assert!(index.stack.get(4).is_none(), "z=4 above maxZoom+1 is not built");
}

#[test]
fn node_size_does_not_change_membership() {
    // nodeSize affects only kd-tree performance/depth, never clustering
    // membership. Two builds with different nodeSize over the same points must
    // produce lattices with identical top-level counts at every zoom.
    let points = common::load_places();
    let a = Supercluster::load(
        points.clone(),
        Options {
            node_size: 2,
            ..common::oracle_options()
        },
    );
    let b = Supercluster::load(
        points,
        Options {
            node_size: 65535,
            ..common::oracle_options()
        },
    );
    for z in 0..=a.options.max_zoom + 1 {
        let la = a.stack.get(z).expect("lattice");
        let lb = b.stack.get(z).expect("lattice");
        assert_eq!(la.len(), lb.len(), "z={z}: nodeSize must not change count");
        assert_eq!(la.num_points, lb.num_points, "z={z}: nodeSize must not change num_points");
    }
}
