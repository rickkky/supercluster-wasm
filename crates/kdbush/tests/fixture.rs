//! Fixture-ported tests: the 100-point corpus and expected `range`/`within`
//! membership from `refs/kdbush/test.js`.
//!
//! These are known-good literals copied from the JavaScript reference's test
//! suite — an independent source of truth (not recomputed the way the code
//! does). Sub-seam A is defined as *membership* (spec line 61: "compares
//! membership, not id values"), so the expected id lists are compared as sets,
//! not as an exact traversal order — the Floyd–Rivest `select` is not a unique
//! partition, and the spec does not require byte-identical ordering. The
//! brute-force set-equality oracle in `tests/brute_force.rs` complements these
//! by checking membership at scale without depending on order.

use kdbush::KDBush;
use std::collections::HashSet;

// 100 points, copied verbatim from refs/kdbush/test.js.
const POINTS: [[u32; 2]; 100] = [
    [54, 1], [97, 21], [65, 35], [33, 54], [95, 39], [54, 3], [53, 54], [84, 72],
    [33, 34], [43, 15], [52, 83], [81, 23], [1, 61], [38, 74], [11, 91], [24, 56],
    [90, 31], [25, 57], [46, 61], [29, 69], [49, 60], [4, 98], [71, 15], [60, 25],
    [38, 84], [52, 38], [94, 51], [13, 25], [77, 73], [88, 87], [6, 27], [58, 22],
    [53, 28], [27, 91], [96, 98], [93, 14], [22, 93], [45, 94], [18, 28], [35, 15],
    [19, 81], [20, 81], [67, 53], [43, 3], [47, 66], [48, 34], [46, 12], [32, 38],
    [43, 12], [39, 94], [88, 62], [66, 14], [84, 30], [72, 81], [41, 92], [26, 4],
    [6, 76], [47, 21], [57, 70], [71, 82], [50, 68], [96, 18], [40, 31], [78, 53],
    [71, 90], [32, 14], [55, 6], [32, 88], [62, 32], [21, 67], [73, 81], [44, 64],
    [29, 50], [70, 5], [6, 22], [68, 3], [11, 23], [20, 42], [21, 73], [63, 86],
    [9, 40], [99, 2], [99, 76], [56, 77], [83, 6], [21, 72], [78, 30], [75, 53],
    [41, 11], [95, 20], [30, 38], [96, 82], [65, 48], [33, 18], [87, 28], [10, 10],
    [40, 34], [10, 20], [47, 29], [46, 78],
];

// range(20, 30, 50, 70) expected ids, copied verbatim from refs/kdbush/test.js.
// Compared as a set — the JS reference's result is a valid membership oracle, but
// traversal order is not a spec requirement (Floyd–Rivest select is non-unique).
const EXPECTED_RANGE: [u32; 18] = [
    60, 20, 45, 3, 17, 71, 44, 19, 18, 15, 69, 90, 62, 96, 47, 8, 77, 72,
];

// within(50, 50, 20) expected ids, copied verbatim from refs/kdbush/test.js.
const EXPECTED_WITHIN: [u32; 12] = [60, 6, 25, 92, 42, 20, 45, 3, 71, 44, 18, 96];

fn make_index() -> KDBush {
    // nodeSize 10, matching refs/kdbush/test.js's makeIndex().
    let mut index = KDBush::new(POINTS.len(), 10);
    for &[x, y] in &POINTS {
        index.add(x as f32, y as f32);
    }
    index.finish().expect("finish");
    index
}

#[test]
fn range_membership_matches_js_fixture() {
    let index = make_index();
    let result = index.range(20.0, 30.0, 50.0, 70.0).expect("range");
    let result_set: HashSet<u32> = result.iter().copied().collect();
    let expected: HashSet<u32> = EXPECTED_RANGE.iter().copied().collect();
    assert_eq!(result_set, expected, "range membership mismatch vs JS fixture");
}

#[test]
fn within_membership_matches_js_fixture() {
    let index = make_index();
    let result = index.within(50.0, 50.0, 20.0).expect("within");
    let result_set: HashSet<u32> = result.iter().copied().collect();
    let expected: HashSet<u32> = EXPECTED_WITHIN.iter().copied().collect();
    assert_eq!(result_set, expected, "within membership mismatch vs JS fixture");
}

#[test]
fn range_result_points_are_all_in_bbox_and_outside_points_excluded() {
    // Mirrors refs/kdbush/test.js's range-search completeness check: every
    // returned id is in the bbox, and every in-bbox point is returned.
    let index = make_index();
    let result = index.range(20.0, 30.0, 50.0, 70.0).expect("range");
    let result_set: HashSet<u32> = result.iter().copied().collect();

    for &id in &result {
        let [x, y] = POINTS[id as usize];
        assert!(
            (20..=50).contains(&x) && (30..=70).contains(&y),
            "returned id {id} ({x},{y}) is outside the bbox"
        );
    }
    for (id, &[x, y]) in POINTS.iter().enumerate() {
        let inside = (20..=50).contains(&x) && (30..=70).contains(&y);
        assert_eq!(
            result_set.contains(&(id as u32)),
            inside,
            "point {id} ({x},{y}) membership mismatch"
        );
    }
}

#[test]
fn within_result_points_are_all_in_radius_and_outside_points_excluded() {
    // Mirrors refs/kdbush/test.js's radius-search completeness check.
    let index = make_index();
    let result = index.within(50.0, 50.0, 20.0).expect("within");
    let result_set: HashSet<u32> = result.iter().copied().collect();
    let r2 = 20.0 * 20.0;

    for &id in &result {
        let [x, y] = POINTS[id as usize];
        let d2 = (x as f64 - 50.0).powi(2) + (y as f64 - 50.0).powi(2);
        assert!(d2 <= r2, "returned id {id} ({x},{y}) is outside the radius");
    }
    for (id, &[x, y]) in POINTS.iter().enumerate() {
        let d2 = (x as f64 - 50.0).powi(2) + (y as f64 - 50.0).powi(2);
        assert_eq!(
            result_set.contains(&(id as u32)),
            d2 <= r2,
            "point {id} ({x},{y}) membership mismatch"
        );
    }
}
