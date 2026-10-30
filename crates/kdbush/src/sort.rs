//! Floyd-Rivest kd-sort: bulk-build the static kd-tree in place.
//!
//! Direct port of `refs/kdbush/index.js`'s `sort` / `select` / `swapItem` /
//! `swap`. The arrays are partitioned around a median index on alternating axes
//! (x, then y, then x, ...) so that, after sorting, every `node_size`-sized
//! slice is a leaf node whose points are roughly co-located — enabling the
//! iterative-DFS `range`/`within` queries to prune whole subtrees.
//!
//! `ids` and `coords` are indexed in lockstep: point `i`'s id is `ids[i]` and
//! its coordinates are `coords[2*i]` (x) / `coords[2*i+1]` (y). `coords` is
//! `f32`-stored (ADR 0003); selection comparisons promote to `f64` so the
//! partition boundaries match the JavaScript reference bit-for-bit (it reads
//! `Float32Array` values into f64 JS numbers).
//!
//! Index conventions match the JS reference exactly: `right` is **inclusive**
//! (the last valid index), so a span `[left, right]` has `right - left + 1`
//! items. The public entry point is [`sort`], called with `right = num_points - 1`.

/// Recursively kd-sort `[left, right]` (inclusive) on alternating axes.
///
/// Returns once a span shrinks to a leaf (`right - left <= node_size`), matching
/// `refs/kdbush/index.js:266` line-for-line; `right` is inclusive.
pub(crate) fn sort(
    ids: &mut [u32],
    coords: &mut [f32],
    node_size: u32,
    left: usize,
    right: usize,
    axis: u8,
) {
    if right - left <= node_size as usize {
        return;
    }

    // Middle index of the inclusive span [left, right].
    let m = (left + right) >> 1;

    // Partition ids/coords around `m` on the current axis so the halves lie
    // left/right (axis 0) or top/bottom (axis 1).
    select(ids, coords, m, left, right, axis);

    // Recurse into each half on the opposite axis. `m` is now in its final
    // sorted position, so it is excluded from both halves.
    if m >= 1 {
        sort(ids, coords, node_size, left, m - 1, 1 - axis);
    }
    sort(ids, coords, node_size, m + 1, right, 1 - axis);
}

/// Floyd-Rivest selection: rearrange `[left, right]` (inclusive) so the `k`-th
/// item (on `axis`) is in its final sorted position, with `[left, k)` smaller
/// and `[k+1, right]` larger.
///
/// Port of `refs/kdbush/index.js`'s `select`. `right` is inclusive. The only
/// deviation from the JS is that coordinate comparisons read `f32` storage into
/// `f64` (JS does this implicitly via `Float32Array` → number promotion), so
/// partitions are bit-identical to the reference. `Math.floor` of a possibly-
/// negative value is handled by [`floor_usize`], which saturates negatives to
/// zero before the surrounding `max`/`min` clamp — matching JS's
/// `Math.max(left, Math.floor(...))` semantics without `as usize` UB.
fn select(
    ids: &mut [u32],
    coords: &mut [f32],
    k: usize,
    mut left: usize,
    mut right: usize,
    axis: u8,
) {
    let ax = axis as usize;
    while right > left {
        // Floyd-Rivest pivot sampling for large spans: shrink [left, right]
        // to a tight window around k before partitioning.
        if right - left > 600 {
            let n = (right - left + 1) as f64;
            let m = (k - left + 1) as f64;
            let z = n.ln();
            let s = 0.5 * (2.0 * z / 3.0).exp();
            let sd = 0.5 * (z * s * (n - s) / n).sqrt() * if m - n / 2.0 < 0.0 { -1.0 } else { 1.0 };
            let new_left = left.max(floor_usize(k as f64 - m * s / n + sd));
            let new_right = right.min(floor_usize(k as f64 + (n - m) * s / n + sd));
            select(ids, coords, k, new_left, new_right, axis);
        }

        let t = f64::from(coords[2 * k + ax]);
        let mut i = left;
        let mut j = right;

        swap_item(ids, coords, left, k);
        if f64::from(coords[2 * right + ax]) > t {
            swap_item(ids, coords, left, right);
        }

        while i < j {
            swap_item(ids, coords, i, j);
            i += 1;
            j -= 1;
            while f64::from(coords[2 * i + ax]) < t {
                i += 1;
            }
            while f64::from(coords[2 * j + ax]) > t {
                j -= 1;
            }
        }

        if f64::from(coords[2 * left + ax]) == t {
            swap_item(ids, coords, left, j);
        } else {
            j += 1;
            swap_item(ids, coords, j, right);
        }

        if j <= k {
            left = j + 1;
        }
        if k <= j {
            right = j - 1;
        }
    }
}

/// `Math.floor` of an `f64` to a `usize`, saturating negatives to `0`.
///
/// JS's `Math.floor` returns `-Infinity`/negative for negative inputs, and
/// `Math.max(left, …)` then clamps to `left ≥ 0`. Saturating to `0` here gives
/// the same result after the caller's `max`/`min` clamp, without `as usize`
/// UB on negatives. Inputs are bounded by `num_points` (≤ `usize::MAX/2`), so
/// positive values never overflow.
fn floor_usize(x: f64) -> usize {
    if x <= 0.0 {
        0
    } else {
        x.floor() as usize
    }
}

/// Swap point `i` and point `j`: their ids and both coordinates move together.
fn swap_item(ids: &mut [u32], coords: &mut [f32], i: usize, j: usize) {
    ids.swap(i, j);
    coords.swap(2 * i, 2 * j);
    coords.swap(2 * i + 1, 2 * j + 1);
}
