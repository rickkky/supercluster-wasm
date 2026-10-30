//! The `Supercluster` build entry point: `load` + the per-zoom `_cluster` loop.
//!
//! A direct, SoA-shaped port of `refs/supercluster/index.js`'s `load` and
//! `_cluster`. The algorithm is preserved verbatim — the radius formula, the
//! "already processed" skip via `last_zoom`, the neighbor-counting, the
//! weighted-center merge, and the "left as unclustered" copy branch — so the
//! Cluster Lattice this builds has identical membership to supercluster's at
//! every zoom (the semantic-equivalence oracle's contract). Only the storage
//! shape differs: SoA arrays instead of an interleaved stride, and the kd-tree
//! is the hand-ported `kdbush` (ticket 02) instead of the JS `kdbush` package.
//!
//! This ticket (03) is the build half: it constructs the lattice and leaves it
//! queryable. The query methods (`getClusters`/`getChildren`/`getLeaves`/
//! `getClusterExpansionZoom`) land in ticket 04/05; the lattice is built and
//! the kd-tree is `finish`-ed so those queries can run, but the query surface
//! itself is not exposed here.

use crate::aggregation::{AggState, AggregationSpec};
use crate::feature::PointFeature;
use crate::lattice::{Lattice, LatticeStack};
use crate::options::Options;

/// A built clustering index: the Cluster Lattice across all zoom levels.
///
/// Construct with [`Supercluster::load`]. After `load`, the lattice stack is
/// populated and each lattice's kd-tree is queryable; the query methods (ticket
/// 04/05) will read it.
pub struct Supercluster {
    /// The options the index was built with.
    pub options: Options,
    /// The full lattice stack (raw lattice at `maxZoom+1`, clustered lattices
    /// down to `minZoom`).
    pub stack: LatticeStack,
    /// The geometry-bearing source features, kept for the query half to
    /// surface as unclustered points (supercluster's `this.points`). Features
    /// with `geometry: null` are dropped on load, matching supercluster.
    pub points: Vec<PointFeature>,
}

impl Supercluster {
    /// Build the index from `points`.
    ///
    /// Projects each geometry-bearing feature to f32 `[0..1]` space, builds the
    /// raw-point lattice at `maxZoom + 1`, then runs the `_cluster` loop from
    /// `maxZoom` down to `minZoom`, building a clustered lattice per zoom from
    /// the zoom-above's lattice. Features with `geometry: null` are skipped
    /// (supercluster's `if (!p.geometry) continue`).
    ///
    /// Returns the built index. Never panics on empty input: an empty `points`
    /// yields an empty raw lattice and empty clustered lattices (matching
    /// supercluster's `load([])` not throwing).
    #[must_use]
    pub fn load(points: Vec<PointFeature>, options: Options) -> Self {
        // Keep only geometry-bearing features. supercluster does this inline in
        // its `load` loop; we do it once up front so the geometry-bearing
        // subset is the source-id space (the oracle's array-index identity).
        let bearing: Vec<&PointFeature> = points.iter().filter(|p| p.coord.is_some()).collect();
        let coords: Vec<[f64; 2]> = bearing.iter().filter_map(|p| p.coord).collect();

        let max_zoom = options.max_zoom;
        let min_zoom = options.min_zoom;

        // The cluster-id offset base is the **full input feature count**
        // (including `geometry: null` features), matching JS supercluster's
        // `this.points.length`. This keeps Rust cluster ids numerically
        // interchangeable with JS supercluster's — `getChildren(164)` over
        // `places.json` resolves to the same cluster on both sides — so the
        // ticket-05 acceptance (which passes literal JS ids from `test.js`)
        // works without an id-translation layer. Source ids stay
        // geometry-bearing indices `[0, geom_bearing)`, which remain `< full
        // count`, so cluster ids stay disjoint from source ids. See
        // `cluster_id.rs`.
        let points_len = points.len();

        // The aggregation spec (ticket 06): empty by default (no spec —
        // clusters carry `point_count` only). When non-empty, the build loop
        // folds per-cluster accumulators and the query half surfaces them.
        let spec = options.spec.clone();

        // The lattice stack spans [0, maxZoom+1]; only [minZoom, maxZoom+1] are
        // built, the rest stay `None` (matching supercluster's sparse `trees`).
        // `options` moves into the stack (Options is no longer Copy once a spec
        // is set); subsequent reads go through `stack.options` / the locals
        // captured here.
        let node_size = options.node_size;
        let mut stack = LatticeStack {
            lattices: (0..=(max_zoom + 1) as usize).map(|_| None).collect(),
            options,
            points_len,
            spec: spec.clone(),
        };

        // Raw-point lattice at maxZoom+1: one entry per geometry-bearing feature.
        // `bearing` seeds each leaf's accumulator row from its feature's
        // `numeric_props` (ticket 06); with no spec, `acc` stays empty.
        let mut raw = Lattice::raw_from_coords(&coords, &bearing, &spec, max_zoom + 1);
        raw.finish(node_size);
        stack.lattices[(max_zoom + 1) as usize] = Some(raw);

        // Cluster from maxZoom down to minZoom. Each zoom's lattice is built
        // from the zoom-above's lattice: zoom `z` clusters the points that
        // survived unclustered (or as clusters) at `z+1`. The `cluster` call
        // mutates the prev lattice in place (recording `last_zoom` and
        // `parent_id` on absorbed entries, matching supercluster's in-place
        // stride mutation), so we `take` it out, cluster, and put it back.
        let mut prev_zoom = max_zoom + 1;
        for z in (min_zoom..=max_zoom).rev() {
            let mut prev = stack
                .lattices
                .get_mut(prev_zoom as usize)
                .and_then(Option::take)
                .expect("previous zoom lattice must be built before clustering");
            let mut next = Self::cluster(&mut prev, z, &stack.options, points_len, &spec);
            next.finish(node_size);
            stack.lattices[prev_zoom as usize] = Some(prev);
            stack.lattices[z as usize] = Some(next);
            prev_zoom = z;
        }

        // Keep the geometry-bearing features for the query half. `points` may
        // include null-geometry features the caller passed; the query half
        // indexes by the geometry-bearing subset, so store that subset.
        let bearing_owned: Vec<PointFeature> = bearing.into_iter().cloned().collect();
        // `stack` already holds `options` (and `spec`); `Supercluster.options`
        // is a second handle for the query half's convenience (tests read
        // `index.options` directly). Clone rather than restructure the public
        // field — the spec's field list is Arc-shared, so this is cheap.
        Self {
            options: stack.options.clone(),
            stack,
            points: bearing_owned,
        }
    }

    /// The per-zoom clustering loop. A direct port of supercluster's `_cluster`.
    ///
    /// Walks each entry in the `prev` lattice (zoom `z+1`); for each
    /// unprocessed entry, finds neighbors via `within(x, y, r)`, and either
    /// merges them into a new cluster (weighted center, parent ids assigned) or
    /// copies them unclustered into the next lattice. The result is the lattice
    /// at zoom `z`, not yet kd-tree-indexed (the caller `finish`-es it).
    ///
    /// `prev` is mutated in place: each absorbed entry's `last_zoom` is set to
    /// `zoom` (so it is not re-processed within this call) and its `parent_id`
    /// is set to the absorbing cluster's id (so the query half's
    /// `getChildren`/`getLeaves` can recover the hierarchy). This mirrors
    /// supercluster's in-place stride mutation (`data[k + OFFSET_ZOOM] = zoom`,
    /// `data[k + OFFSET_PARENT] = id`).
    ///
    /// **Aggregation fold (ticket 06):** when a cluster forms, its accumulator
    /// row = the origin's row combined with each absorbed child's row, via
    /// [`AggState::combine`]. This mirrors JS supercluster's
    /// `reduce(clusterProperties, this._map(data, k))`: the origin's mapped
    /// props seed the accumulator (`_map(data, i, true)` at the first child),
    /// then each child's mapped props are reduced in. A sub-cluster child
    /// contributes its *own* already-folded accumulator (JS's `_map` returns
    /// `clusterProps[propIndex]` for a `numPoints > 1` entry), so the fold is
    /// hierarchical and `cluster.sum = Σ leaf scalerank` — identical to JS.
    fn cluster(
        prev: &mut Lattice,
        zoom: i32,
        options: &Options,
        points_len: usize,
        spec: &AggregationSpec,
    ) -> Lattice {
        let r = options.radius_at_zoom(zoom);
        let min_points = options.min_points;
        let n = prev.len();
        let stride = spec.len();

        let mut next = Lattice::empty_at(zoom, n, stride);

        for i in 0..n {
            // Already processed at this zoom (absorbed into a cluster): skip.
            if prev.last_zoom[i] <= zoom {
                continue;
            }
            prev.last_zoom[i] = zoom;

            // Query point and weighted-center accumulation both read the f64
            // center from `x`/`y` (supercluster's `data[]`); only the kd-tree
            // f32-rounds. See ADR 0003 "Cluster centers are f64, not f32".
            let x = prev.x[i];
            let y = prev.y[i];
            let neighbor_ids = prev.within(x, y, r);

            let num_points_origin = prev.num_points[i];
            let mut num_points = num_points_origin;

            // Count points in the potential cluster: every unprocessed neighbor
            // contributes its num_points.
            for &nid in &neighbor_ids {
                let k = nid as usize;
                if prev.last_zoom[k] > zoom {
                    num_points += prev.num_points[k];
                }
            }

            // Form a cluster iff there were neighbors to merge AND the merged
            // count meets minPoints.
            if num_points > num_points_origin && num_points >= min_points {
                let mut wx = x * f64::from(num_points_origin);
                let mut wy = y * f64::from(num_points_origin);

                // Cluster id: origin point index `i`, originating at `zoom`.
                let id = crate::cluster_id::encode(i, zoom, points_len);

                // Seed the cluster's accumulator from the origin's row (JS's
                // `_map(data, i, true)` — a *clone* of the origin's mapped
                // props, so the origin's state is not mutated by the reduce).
                // `to_vec` clones the row; the fold then combines each child
                // into this owned copy.
                let mut acc_row: Vec<AggState> = prev.acc_row(i).to_vec();

                for &nid in &neighbor_ids {
                    let k = nid as usize;
                    if prev.last_zoom[k] <= zoom {
                        continue;
                    }
                    prev.last_zoom[k] = zoom; // mark absorbed so it isn't re-processed
                    prev.parent_id[k] = id; // record parent for getChildren/getLeaves

                    let num_points2 = prev.num_points[k];
                    wx += prev.x[k] * f64::from(num_points2);
                    wy += prev.y[k] * f64::from(num_points2);

                    // Fold this child's accumulator into the cluster's (JS's
                    // `reduce(clusterProperties, this._map(data, k))`). For a
                    // sub-cluster child, `acc_row(k)` is its own folded state;
                    // for a leaf, its seeded state. Either way, combine.
                    if stride > 0 {
                        let child_row = prev.acc_row(k);
                        for (idx, child_state) in child_row.iter().enumerate() {
                            acc_row[idx] = acc_row[idx].combine(*child_state);
                        }
                    }
                }

                // The origin point is itself absorbed into this cluster: record
                // its parent (supercluster's `data[i + OFFSET_PARENT] = id`, line
                // 338) so getChildren/getLeaves recover it as a child. Without
                // this, the origin point would be orphaned and drill-down would
                // drop one point per cluster.
                prev.parent_id[i] = id;

                // Weighted center, **unfrounded f64** (matching supercluster's
                // `nextData.push(wx / numPoints, ...)` — the center is never
                // `fround`-ed on the data path; only the kd-tree f32-rounds it
                // in `finish`). See ADR 0003.
                let cx = wx / f64::from(num_points);
                let cy = wy / f64::from(num_points);
                next.push_cluster(cx, cy, id, num_points, acc_row);
            } else {
                // Left as unclustered: copy this entry through.
                next.push_point_from(prev, i);

                // If it had neighbors (but not enough to cluster), copy the
                // unprocessed neighbors through too, matching supercluster's
                // `numPoints > 1` branch.
                if num_points > 1 {
                    for &nid in &neighbor_ids {
                        let k = nid as usize;
                        if prev.last_zoom[k] <= zoom {
                            continue;
                        }
                        prev.last_zoom[k] = zoom;
                        next.push_point_from(prev, k);
                    }
                }
            }
        }

        next
    }
}

// Parent assignment: supercluster writes `data[k + OFFSET_PARENT] = id` on the
// prev stride during `_cluster`, so `getChildren` can scan for entries whose
// parent matches a cluster id. The build loop does the same (see `cluster`),
// persisting `parent_id` on each absorbed entry. The query half (ticket 05)
// recovers children by scanning the origin-zoom lattice for entries whose
// `parent_id` matches the cluster id — exactly supercluster's `getChildren`.
// `last_zoom` is likewise persisted so a future re-cluster (not used here, but
// matching supercluster's mutable-stride contract) sees the absorption marker.
