//! Hand-ported static kd-tree spatial index.
//!
//! Mirrors `refs/kdbush/index.js` algorithmically: Floyd-Rivest bulk-build
//! kd-sort over flat `ids`/`coords` arrays, and iterative-DFS `range` (bbox)
//! and `within` (radius) queries with circle-bbox pruning plus squared-distance
//! post-filter. Coordinates are stored as `f32` (ADR 0003); query arithmetic
//! runs in `f64` so pruning boundaries match the JavaScript reference exactly,
//! keeping both this crate's brute-force oracle and the downstream
//! semantic-equivalence oracle free of boundary noise.
//!
//! The index is build-once and opaque: there is no serialized `ArrayBuffer`
//! format (ADR 0002 — the index stays in WASM linear memory, never exposed to
//! JS), and no `from`/reconstruction path.

mod sort;

use sort::sort;

/// A static kd-tree over a fixed set of 2D points.
///
/// Construct with [`KDBush::new`], feed points via [`KDBush::add`], then call
/// [`KDBush::finish`] to kd-sort the arrays. After `finish`, [`range`](Self::range)
/// and [`within`](Self::within) answer bbox and radius queries.
pub struct KDBush {
    /// Per-slot point id. After `finish`, kd-sorted so tree nodes are contiguous
    /// slices of `ids`/`coords`.
    ids: Vec<u32>,
    /// Interleaved `[x0, y0, x1, y1, ...]` coordinates, `f32`-stored (ADR 0003).
    /// Indexed in lockstep with `ids` (point `i` lives at `2*i`, `2*i+1`).
    coords: Vec<f32>,
    /// Next write position in `coords` (and `ids`), measured in coordinate
    /// slots — i.e. `2 * number_of_added_points`. `usize::MAX` once finished.
    pos: usize,
    /// Number of points the index was sized for. `finish` rejects a mismatch.
    num_points: usize,
    /// KD-tree leaf node size (clamped to `[2, 65535]` on construction).
    node_size: u32,
    /// `true` once `finish` has kd-sorted the arrays; queries require it.
    finished: bool,
}

impl KDBush {
    /// Create an index sized for exactly `num_points` points.
    ///
    /// `node_size` is the KD-tree leaf node size (larger → shallower tree, more
    /// linear scanning per query; smaller → deeper tree, more recursion). It is
    /// clamped to `[2, 65535]`, matching `refs/kdbush`. supercluster uses 64.
    ///
    /// Panics if `num_points` would overflow the coordinate array
    /// (`num_points > usize::MAX / 2`).
    #[must_use]
    pub fn new(num_points: usize, node_size: u32) -> Self {
        assert!(
            num_points <= usize::MAX / 2,
            "num_points {num_points} overflows the coordinate array"
        );
        Self {
            ids: vec![0; num_points],
            coords: vec![0.0; num_points * 2],
            pos: 0,
            num_points,
            node_size: node_size.clamp(2, 65535),
            finished: false,
        }
    }

    /// Add a point, returning its incremental index (starting from `0`).
    ///
    /// Panics if called more than `num_points` times or after [`finish`](Self::finish).
    pub fn add(&mut self, x: f32, y: f32) -> usize {
        assert!(!self.finished, "cannot add after finish()");
        assert!(self.pos < self.num_points * 2, "added more than num_points points");
        let index = self.pos >> 1;
        self.ids[index] = index as u32;
        self.coords[self.pos] = x;
        self.coords[self.pos + 1] = y;
        self.pos += 2;
        index
    }

    /// kd-sort the added points, making the index queryable.
    ///
    /// Returns `Err` if the number of added points does not equal `num_points`,
    /// matching `refs/kdbush`'s "Added N items when expected M" check.
    pub fn finish(&mut self) -> Result<(), &'static str> {
        // Idempotent: a second `finish` on an already-finished index is a no-op
        // (the count check below would otherwise misfire, since `pos` is sealed
        // to `usize::MAX` after the first finish).
        if self.finished {
            return Ok(());
        }
        let num_added = self.pos >> 1;
        if num_added != self.num_points {
            return Err("added point count does not match num_points");
        }
        // `sort` takes an inclusive `right`; the last valid index is
        // `num_points - 1`. An empty index (num_points == 0) skips sorting.
        if self.num_points > 0 {
            sort(
                &mut self.ids,
                &mut self.coords,
                self.node_size,
                0,
                self.num_points - 1,
                0,
            );
        }
        self.finished = true;
        self.pos = usize::MAX; // seal against further adds
        Ok(())
    }

    /// Search the index for point ids within a bounding box.
    ///
    /// Returns ids in kd-tree traversal order (matching `refs/kdbush`'s
    /// `range`). Requires [`finish`](Self::finish); returns `Err` otherwise.
    ///
    /// # Errors
    /// If called before `finish`.
    pub fn range(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
    ) -> Result<Vec<u32>, &'static str> {
        if !self.finished {
            return Err("data not yet indexed — call finish() first");
        }
        let mut out = Vec::new();
        self.query(
            |x, y| x >= min_x && x <= max_x && y >= min_y && y <= max_y,
            |axis| if axis == 0 { (min_x, max_x) } else { (min_y, max_y) },
            &mut out,
        );
        Ok(out)
    }

    /// Search the index for point ids within `r` of `(qx, qy)`.
    ///
    /// Returns ids in kd-tree traversal order (matching `refs/kdbush`'s
    /// `within`). Requires [`finish`](Self::finish); returns `Err` otherwise.
    ///
    /// # Errors
    /// If called before `finish`.
    pub fn within(&self, qx: f64, qy: f64, r: f64) -> Result<Vec<u32>, &'static str> {
        if !self.finished {
            return Err("data not yet indexed — call finish() first");
        }
        let r2 = r * r;
        let mut out = Vec::new();
        self.query(
            |x, y| sq_dist(x, y, qx, qy) <= r2,
            |axis| if axis == 0 { (qx - r, qx + r) } else { (qy - r, qy + r) },
            &mut out,
        );
        Ok(out)
    }

    /// Iterative-DFS shared by [`range`](Self::range) and [`within`](Self::within).
    ///
    /// `included(x, y)` decides whether a point is in the result set (the leaf
    /// scan and the median test both use it). `descend(axis)` returns the
    /// `(lo, hi)` query interval on the given axis, used to decide which
    /// subtrees the query overlaps. Generic monomorphization specializes this
    /// per call site, so the closures inline — no dynamic-dispatch overhead.
    ///
    /// The DFS scratch stack is reused across calls; `out` is not cleared, so
    /// repeated calls accumulate. Worst-case depth is the tree height, bounded
    /// for a balanced kd-tree by `ceil(log2(num_points))`; 128 frames is ample
    /// for any `usize`-addressable point count (depth ≤ ~63).
    fn query<P, D>(&self, included: P, descend: D, out: &mut Vec<u32>)
    where
        P: Fn(f64, f64) -> bool,
        D: Fn(u8) -> (f64, f64),
    {
        if self.num_points == 0 {
            return;
        }
        let mut stack: [(usize, usize, u8); 128] = [(0, 0, 0); 128];
        let mut sp = 0usize;
        let last = self.num_points.saturating_sub(1);
        stack[sp] = (0, last, 0);
        sp += 1;

        while sp > 0 {
            sp -= 1;
            let (left, right, axis) = stack[sp];

            // Leaf node: scan linearly, post-filter by the inclusion predicate.
            if right - left <= self.node_size as usize {
                for i in left..=right {
                    let x = f64::from(self.coords[2 * i]);
                    let y = f64::from(self.coords[2 * i + 1]);
                    if included(x, y) {
                        out.push(self.ids[i]);
                    }
                }
                continue;
            }

            // Internal node: the median sits at the midpoint of [left, right].
            let m = (left + right) >> 1;
            let x = f64::from(self.coords[2 * m]);
            let y = f64::from(self.coords[2 * m + 1]);
            if included(x, y) {
                out.push(self.ids[m]);
            }

            // Descend into the half(es) the query interval overlaps.
            let (lo, hi) = descend(axis);
            let coord = if axis == 0 { x } else { y };
            if lo <= coord && m >= 1 {
                stack[sp] = (left, m - 1, 1 - axis);
                sp += 1;
            }
            if hi >= coord {
                stack[sp] = (m + 1, right, 1 - axis);
                sp += 1;
            }
        }
    }
}

/// Squared Euclidean distance between `(ax, ay)` and `(bx, by)`, computed in
/// `f64` (ADR 0003: intermediate accumulations may use f64 to avoid error
/// growth; the radius comparison thus matches the JavaScript reference exactly).
fn sq_dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_points_does_not_panic_and_returns_empty() {
        let mut index = KDBush::new(0, 64);
        index.finish().expect("finish on empty index");
        assert!(index.range(0.0, 0.0, 10.0, 10.0).unwrap().is_empty());
        assert!(index.within(0.0, 0.0, 10.0).unwrap().is_empty());
    }

    #[test]
    fn finish_rejects_count_mismatch() {
        let mut index = KDBush::new(10, 64);
        index.add(1.0, 2.0);
        assert!(index.finish().is_err());
    }

    #[test]
    fn range_before_finish_is_err() {
        let mut index = KDBush::new(4, 64);
        index.add(0.0, 0.0);
        index.add(1.0, 1.0);
        index.add(2.0, 2.0);
        index.add(3.0, 3.0);
        assert!(index.range(0.0, 0.0, 5.0, 5.0).is_err());
        assert!(index.within(0.0, 0.0, 5.0).is_err());
    }

    #[test]
    fn node_size_is_clamped() {
        let a = KDBush::new(10, 0);
        let b = KDBush::new(10, 1);
        let c = KDBush::new(10, 70000);
        // Clamped to [2, 65535]: 0 and 1 -> 2, 70000 -> 65535.
        assert_eq!(a.node_size, 2);
        assert_eq!(b.node_size, 2);
        assert_eq!(c.node_size, 65535);
    }
}
