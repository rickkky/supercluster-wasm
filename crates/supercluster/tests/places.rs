//! Cross-check against the JS supercluster reference: the number of top-level
//! entries (clusters + unclustered points) at each zoom must match what JS
//! supercluster produces for the same input and options.
//!
//! This is the strongest acceptance available without the query half (ticket
//! 04): it proves the build produces the *correct* cluster *shape* — not just a
//! structurally-valid lattice. The expected counts are computed once from
//! `refs/supercluster/index.js` (the oracle's reference implementation) over
//! `places.json` with `maxZoom: 6` (the oracle's `DEFAULT_OPTIONS`), and pinned
//! here as literals so the test is independent of the JS runtime at test time.
//!
//! A count match is necessary but not sufficient for full semantic equivalence
//! (two different clusterings can have the same count). The full membership
//! diff lands in ticket 04's query-half oracle; here we assert the per-zoom
//! top-level count and the partition property together, which catches the
//! common failure modes (over- or under-clustering at a zoom).

mod common;

use supercluster::supercluster::Supercluster;

/// JS supercluster's top-level entry count per zoom for `places.json` with
/// `maxZoom: 6` (the oracle's `DEFAULT_OPTIONS`), computed via
/// `index.getClusters([-180, -90, 180, 90], z).length` for `z in [0, 7]`.
/// Zoom 7 is `maxZoom + 1` (the raw-point lattice): 162 singletons (the 162
/// geometry-bearing features; the one `geometry: null` "Null Island" feature is
/// skipped on load).
const EXPECTED_TOP_LEVEL: [u32; 8] = [32, 61, 100, 137, 149, 159, 162, 162];

#[test]
fn top_level_count_matches_js_supercluster_for_places_json() {
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    for z in 0..=7 {
        let lattice = index
            .stack
            .get(z)
            .unwrap_or_else(|| panic!("lattice at zoom {z} must be built"));
        assert_eq!(
            lattice.len(),
            EXPECTED_TOP_LEVEL[z as usize] as usize,
            "zoom {z}: top-level entry count {} != JS supercluster's {}",
            lattice.len(),
            EXPECTED_TOP_LEVEL[z as usize]
        );
    }
}

#[test]
fn top_level_count_is_monotonic_nondecreasing_as_zoom_increases() {
    // As zoom increases (zooming in), clusters only split — never merge. So
    // the top-level count is non-decreasing as zoom increases: count(z) >=
    // count(z-1). This is a structural invariant of the Cluster Hierarchy: an
    // entry at z-1 is the union of one or more entries at z.
    let points = common::load_places();
    let index = Supercluster::load(points, common::oracle_options());
    let mut prev = 0u32;
    for z in 0..=index.options.max_zoom + 1 {
        let count = index.stack.get(z).expect("lattice").len() as u32;
        assert!(
            count >= prev,
            "zoom {z}: count {count} < previous zoom's {prev} (clusters merged on zoom-in)"
        );
        prev = count;
    }
}

#[test]
fn raw_lattice_at_max_zoom_plus_1_is_all_singletons() {
    // Mirrors test/oracle.test.js's "maxZoom+1 is all singletons": the raw
    // lattice (no clustering) has one entry per geometry-bearing source point,
    // each with num_points 1.
    let points = common::load_places();
    let geometry_bearing = points.iter().filter(|p| p.coord.is_some()).count();
    let index = Supercluster::load(points, common::oracle_options());
    let raw = index
        .stack
        .get(index.options.max_zoom + 1)
        .expect("raw lattice at maxZoom+1");
    assert_eq!(raw.len(), geometry_bearing);
    for i in 0..raw.len() {
        assert_eq!(raw.num_points[i], 1, "raw lattice entry {i} is not a singleton");
    }
}
