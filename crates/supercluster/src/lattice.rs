//! Cluster Lattice: the SoA layout + per-zoom kd-tree.
//!
//! One `Lattice` exists per Zoom Level (plus the raw-point lattice at
//! `maxZoom + 1`). It holds, in Structure-of-Arrays form, every top-level
//! Cluster and unclustered Point at that zoom: `x`/`y` (projected, f64-carrying
//! — raw points hold an f32-rounded value, cluster centers an unfrounded f64;
//! see ADR 0003 "Cluster centers are f64, not f32"), `last_zoom`, `source_id`,
//! `parent_id`, `num_points` as parallel arrays.
//!
//! The SoA layout (vs supercluster's interleaved stride AoS) is chosen for
//! cache efficiency on the radius-query hot path, which reads only `x`/`y`
//! (Q19). The kd-tree is the hand-ported `kdbush` (ticket 02); it indexes the
//! same `x`/`y` pairs (f32-rounded at `finish` time) so `within` radius
//! queries drive the clustering loop.
//!
//! `last_zoom` plays supercluster's `OFFSET_ZOOM` role: it records the last
//! zoom at which a point was processed, so a point already absorbed into a
//! cluster at zoom `z` is not re-processed when another neighbor finds it. It
//! starts at `i32::MAX` (supercluster's `Infinity` sentinel) for raw points.

use crate::aggregation::{AggState, AggregationSpec};
use crate::options::Options;
use crate::projection::fround;
use kdbush::KDBush;

/// A Cluster Lattice at one Zoom Level: the SoA arrays + the kd-tree indexing
/// them.
///
/// Arrays are indexed in lockstep: point `i`'s data lives at `[i]` in every
/// array. The kd-tree's `ids` reference these indices, so a `within` result is a
/// list of lattice indices.
pub struct Lattice {
    /// Projected x. f64-carrying: raw points hold an f32-rounded value promoted
    /// to f64 (`fround(lng_x(lng))`); cluster centers hold an **unfrounded** f64
    /// weighted center (`wx / num_points`), matching supercluster's `data[]`.
    /// Only the kd-tree (built in [`finish`](Self::finish)) f32-rounds. See ADR
    /// 0003 "Cluster centers are f64, not f32".
    pub x: Vec<f64>,
    /// Projected y. Same f64/f32 split as `x`.
    pub y: Vec<f64>,
    /// Last zoom this point was processed at. `i32::MAX` for unprocessed/raw.
    pub last_zoom: Vec<i32>,
    /// Source-feature index for unclustered points, or the cluster's own id
    /// for clusters (supercluster's `OFFSET_ID` dual role).
    pub source_id: Vec<u32>,
    /// Parent cluster id, or `u32::MAX` (-1 in supercluster) for top-level.
    pub parent_id: Vec<u32>,
    /// Number of source points this entry represents: 1 for an unclustered
    /// point, `>1` for a cluster.
    pub num_points: Vec<u32>,
    /// Aggregation accumulators, flat SoA: entry `i`'s state for spec field
    /// `f` is at `acc[i * acc_stride + f]`. `acc_stride` = the spec's field
    /// count; empty when there is no spec (the common case — clusters then
    /// carry `point_count` only). Same lifecycle as `num_points`: seeded from
    /// the raw lattice, folded during `_cluster`, carried through on the
    /// "left unclustered" branch. See ticket 06.
    pub acc: Vec<AggState>,
    /// Stride between entries in `acc` (= spec field count). 0 when there is
    /// no spec, so `acc` is empty and indexing is a no-op.
    pub acc_stride: usize,
    /// The kd-tree indexing `x`/`y`. `None` until `finish` builds it.
    tree: Option<KDBush>,
    /// The zoom this lattice was built at. `maxZoom + 1` for the raw lattice.
    pub zoom: i32,
}

/// The sentinel for "no parent" (supercluster's `-1`). `u32::MAX` keeps the
/// array unsigned so the SoA fields are all `Vec<u32>`/`Vec<i32>`/`Vec<f32>`.
pub const NO_PARENT: u32 = u32::MAX;

impl Lattice {
    /// The number of entries (top-level clusters + unclustered points) at this
    /// zoom.
    #[must_use]
    pub fn len(&self) -> usize {
        self.x.len()
    }

    /// Whether the lattice is empty (no entries).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    /// Construct an empty lattice at `zoom`, preallocated for `cap` entries.
    /// The kd-tree is `None` until [`finish`](Self::finish).
    ///
    /// `acc_stride` is the spec's field count (0 if there is no spec); `acc`
    /// is preallocated for `cap * acc_stride` states.
    pub(crate) fn empty_at(zoom: i32, cap: usize, acc_stride: usize) -> Self {
        Lattice {
            x: Vec::with_capacity(cap),
            y: Vec::with_capacity(cap),
            last_zoom: Vec::with_capacity(cap),
            source_id: Vec::with_capacity(cap),
            parent_id: Vec::with_capacity(cap),
            num_points: Vec::with_capacity(cap),
            acc: Vec::with_capacity(cap * acc_stride),
            acc_stride,
            tree: None,
            zoom,
        }
    }

    /// Build the kd-tree over the current `x`/`y` arrays, making the lattice
    /// queryable via [`within`](Self::within).
    ///
    /// Mirrors supercluster's `_createTree`: a `KDBush` sized to the entry
    /// count, fed each entry's `x`/`y` **f32-rounded** (matching supercluster's
    /// `Float32Array` `coords`), then `finish`-ed. The `x`/`y` arrays themselves
    /// stay f64 (supercluster's `data[]`); only the tree f32-rounds. See ADR
    /// 0003. After this, the lattice is sealed — the build loop constructs a
    /// *new* lattice for the next zoom rather than mutating this one.
    pub fn finish(&mut self, node_size: u32) {
        let n = self.len();
        let mut tree = KDBush::new(n, node_size);
        for i in 0..n {
            // f32-round into the tree, matching supercluster's Float32Array.
            tree.add(fround(self.x[i]) as f32, fround(self.y[i]) as f32);
        }
        tree.finish().expect("finish: count matches add count");
        self.tree = Some(tree);
    }

    /// Radius query: lattice indices within `r` of `(qx, qy)`, in kd-tree
    /// traversal order (matching supercluster's `tree.within`).
    ///
    /// Panics if called before [`finish`](Self::finish).
    #[must_use]
    pub fn within(&self, qx: f64, qy: f64, r: f64) -> Vec<u32> {
        self.tree
            .as_ref()
            .expect("within before finish")
            .within(qx, qy, r)
            .expect("within: tree finished")
    }

    /// Bounding-box query: lattice indices within `[min_x, max_x]` ×
    /// `[min_y, max_y]`, in kd-tree traversal order (matching supercluster's
    /// `tree.range`). The query half (ticket 04) calls this for `getClusters`'s
    /// viewport extraction.
    ///
    /// Panics if called before [`finish`](Self::finish).
    #[must_use]
    pub fn range(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Vec<u32> {
        self.tree
            .as_ref()
            .expect("range before finish")
            .range(min_x, min_y, max_x, max_y)
            .expect("range: tree finished")
    }

    /// Push a raw (unclustered) source point, copying its SoA row from the
    /// previous zoom's lattice. Used by the build loop's "left as unclustered"
    /// branch. The accumulator row is copied through verbatim — an
    /// unclustered point's aggregated state is whatever it carried (a leaf's
    /// seeded state, or a cluster's folded state if it survived unclustered).
    pub(crate) fn push_point_from(&mut self, prev: &Lattice, i: usize) {
        self.x.push(prev.x[i]);
        self.y.push(prev.y[i]);
        self.last_zoom.push(prev.last_zoom[i]);
        self.source_id.push(prev.source_id[i]);
        self.parent_id.push(prev.parent_id[i]);
        self.num_points.push(prev.num_points[i]);
        let s = self.acc_stride;
        if s > 0 {
            let base = i * s;
            self.acc.extend_from_slice(&prev.acc[base..base + s]);
        }
    }

    /// Push a freshly-created cluster: its **unfrounded f64** weighted center
    /// (matching supercluster's `nextData.push(wx / numPoints, ...)` — the
    /// center is never `fround`-ed on the `data` path; only the kd-tree
    /// f32-rounds it, in [`finish`](Self::finish)), the cluster id as its
    /// `source_id`, no parent, and the merged point count. See ADR 0003.
    ///
    /// `acc` is the cluster's folded accumulator row (origin combined with
    /// every absorbed child's state — computed by the build loop, which knows
    /// the children). Empty if there is no spec.
    pub(crate) fn push_cluster(
        &mut self,
        x: f64,
        y: f64,
        id: u32,
        num_points: u32,
        acc: Vec<AggState>,
    ) {
        self.x.push(x);
        self.y.push(y);
        // A new cluster is unprocessed at the *next* (lower) zoom; sentinel
        // it like a raw point so the next loop iteration can absorb it.
        self.last_zoom.push(i32::MAX);
        self.source_id.push(id);
        self.parent_id.push(NO_PARENT);
        self.num_points.push(num_points);
        // debug-assert the row length matches the lattice's stride; a
        // mismatch would desync every subsequent entry's row.
        debug_assert_eq!(
            acc.len(),
            self.acc_stride,
            "push_cluster: acc row length != acc_stride"
        );
        self.acc.extend(acc);
    }

    /// Construct the raw-point lattice at `maxZoom + 1`: one entry per
    /// geometry-bearing source feature, projected to f32 `[0..1]` space.
    ///
    /// `coords` is the `[lng, lat]` pair for each geometry-bearing feature
    /// (the caller has already skipped `geometry: null` features, matching
    /// supercluster's `if (!p.geometry) continue`). The source id is the
    /// feature's index into that geometry-bearing subset — which is also its
    /// index into `coords` — so the oracle's array-index identity holds.
    ///
    /// `bearing` is the same geometry-bearing subset (as references, in the
    /// same order), so each raw entry's accumulator row can be seeded from its
    /// feature's `numeric_props` (ticket 06). With no spec, `acc` stays empty
    /// and the lattice is byte-for-byte the pre-aggregation shape (the common
    /// case).
    pub(crate) fn raw_from_coords(
        coords: &[[f64; 2]],
        bearing: &[&crate::feature::PointFeature],
        spec: &AggregationSpec,
        zoom: i32,
    ) -> Self {
        use crate::projection::{lat_y, lng_x};
        let n = coords.len();
        let stride = spec.len();
        let mut raw = Lattice {
            x: Vec::with_capacity(n),
            y: Vec::with_capacity(n),
            last_zoom: vec![i32::MAX; n],
            // Source id = index into the geometry-bearing subset. Cluster ids
            // are offset above `points_len` (the full input count) at encode
            // time, so raw source ids `[0, n)` are disjoint from any cluster id
            // (and `< points_len` since `n <= points_len`).
            source_id: (0..n as u32).collect(),
            parent_id: vec![NO_PARENT; n],
            num_points: vec![1; n],
            acc: Vec::with_capacity(n * stride),
            acc_stride: stride,
            tree: None,
            zoom,
        };
        for (i, &[lng, lat_v]) in coords.iter().enumerate() {
            // Raw points: f32-rounded on ingest (matching supercluster's
            // `fround(lngX(lng))`), stored as f64 carrying the f32 value. See
            // ADR 0003.
            raw.x.push(fround(lng_x(lng)));
            raw.y.push(fround(lat_y(lat_v)));
            // Seed this leaf's accumulator row: one AggState per spec field,
            // from_value if the feature carries the property, identity if not
            // (a missing property contributes nothing — the accumulator stays
            // at its identity, matching JS reading `undefined`). This is the
            // JS `_map(data, i)` for a raw point: `map(props)`.
            if stride > 0 {
                for f in spec.iter() {
                    let state = bearing[i]
                        .get_numeric(f.prop)
                        .map(|v| AggState::from_value(f.op, v))
                        .unwrap_or_else(|| AggState::identity(f.op));
                    raw.acc.push(state);
                }
            }
        }
        raw
    }

    /// Read entry `i`'s accumulator row (length `acc_stride`). Empty slice
    /// when there is no spec. Used by the query half to surface aggregated
    /// properties in `getClusters`.
    #[must_use]
    pub fn acc_row(&self, i: usize) -> &[AggState] {
        let s = self.acc_stride;
        if s == 0 {
            return &[];
        }
        let base = i * s;
        &self.acc[base..base + s]
    }
}

/// The full Cluster Lattice stack across all zoom levels, plus the raw-point
/// lattice at `maxZoom + 1`.
///
/// `lattices[z]` is the lattice at zoom `z` for `z in [minZoom, maxZoom]`;
/// `lattices[maxZoom + 1]` is the raw-point lattice. This mirrors
/// supercluster's `this.trees` array indexing.
pub struct LatticeStack {
    /// Indexed by zoom. `lattices[z]` exists for `z in [minZoom, maxZoom+1]`.
    pub lattices: Vec<Option<Lattice>>,
    /// The options the stack was built with (radius formula, points_len for
    /// id encoding). Held so the query half (ticket 04/05) can decode cluster
    /// ids and compute `getChildren` radii without re-threading state.
    pub options: Options,
    /// Total source-feature count (the **full input**, including `geometry:
    /// null` features), matching JS supercluster's `this.points.length`. This
    /// is the cluster-id offset base — cluster ids are offset above it so they
    /// stay disjoint from source-feature ids `[0, geom_bearing)` (the
    /// geometry-bearing subset, since `geometry: null` features are dropped
    /// on load and never get a source id). See `cluster_id.rs`.
    pub points_len: usize,
    /// The aggregation spec the stack was built with (ticket 06). Held so the
    /// query half can finalize and surface aggregated properties in
    /// `getClusters` without re-threading it. Empty (no spec) is the common
    /// case — clusters then carry `point_count` only.
    pub spec: AggregationSpec,
}

impl LatticeStack {
    /// Access the lattice at `zoom`, if it was built.
    #[must_use]
    pub fn get(&self, zoom: i32) -> Option<&Lattice> {
        self.lattices.get(zoom as usize).and_then(Option::as_ref)
    }
}
