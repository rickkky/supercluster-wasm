//! The query half of the clustering stack (ticket 04): `get_clusters`.
//!
//! A direct port of `refs/supercluster/index.js`'s `getClusters` (lines 89-113)
//! and its `_limitZoom` helper (lines 273-275). The algorithm is preserved
//! verbatim — the bbox normalization (longitude wrap-mod-360, latitude clamp),
//! the antimeridian split into eastern/western hemisphere queries whose results
//! concatenate, the zoom limiting (floor + clamp to `[minZoom, maxZoom+1]`),
//! and the kd-tree `range` over the projected bbox — so the Cluster Lattice
//! this queries yields identical membership to supercluster at every zoom (the
//! semantic-equivalence oracle's contract).
//!
//! Results are returned in a Rust-native form ([`ClusterFeature`]) consumable by
//! the later WASM boundary (ticket 07); nothing here depends on `wasm-bindgen`
//! or touches JS types. A result entry is either a Cluster (carrying its
//! `cluster_id` and `num_points`) or an unclustered Point (carrying its source
//! `feature_id`), plus the projected coordinate — enough for the boundary to
//! serialize and for the oracle to recover membership.
//!
//! Edge behavior matches supercluster verbatim (User Story 9 / Q16):
//!   - out-of-range bbox longitudes wrap (`((x+180)%360+360)%360-180`), not
//!     reject; latitudes clamp to `[-90, 90]`;
//!   - a bbox spanning >= 360° collapses to the whole world;
//!   - a bbox whose wrapped min-lng > max-lng crosses the antimeridian and
//!     splits into an eastern + western hemisphere query;
//!   - non-integer zooms floor to integer before clamping;
//!   - empty input yields an empty result without panicking.

use std::collections::HashMap;

use crate::projection::{lat_y, lng_x};

/// A single result entry from [`Supercluster::get_clusters`]: either a Cluster
/// or an unclustered Point, in a Rust-native form the WASM boundary (ticket 07)
/// will serialize and the oracle (ticket 04) will traverse.
///
/// Mirrors supercluster's `getClusters` output shape — a Cluster becomes a
/// GeoJSON Feature with `cluster: true` / `cluster_id` / `point_count`; an
/// unclustered Point becomes the original source feature — but here it stays a
/// plain struct so the crate has no JSON dependency and the boundary owns the
/// GeoJSON assembly.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterFeature {
    /// The entry's projected x in `[0..1]` spherical-mercator space. For a
    /// Cluster, the weighted center (f64, unfrounded — ADR 0003); for a Point,
    /// the f32-rounded projection promoted to f64 (matching the stored coord).
    pub x: f64,
    /// The entry's projected y. Same f64/f32 split as `x`.
    pub y: f64,
    /// `Cluster` if this entry represents a merged cluster (num_points > 1);
    /// `Point` if it is an unclustered source point.
    pub kind: FeatureKind,
}

/// Whether a [`ClusterFeature`] is a Cluster or an unclustered Point, carrying
/// the id each case needs.
#[derive(Debug, Clone, PartialEq)]
pub enum FeatureKind {
    /// A merged Cluster: its `cluster_id` (offset above `points_len`, stable
    /// and drillable — see `cluster_id.rs`), the number of source Points it
    /// represents, and the per-spec-field aggregated values (ticket 06).
    /// Mirrors supercluster's `data[k + OFFSET_ID]` / `OFFSET_NUM` plus the
    /// `clusterProps` the JS `reduce` accumulates. Empty when the index was
    /// built with no [`AggregationSpec`] (the common case — clusters then
    /// carry `point_count` only).
    Cluster {
        cluster_id: u32,
        num_points: u32,
        /// `(name, finalized_value)` per spec field, in spec order. The query
        /// half finalizes each [`AggState`] (mean = sum/count) at surfacing
        /// time. Empty iff the index was built with no spec.
        aggregated: Vec<(String, f64)>,
    },
    /// An unclustered source Point: its index into the geometry-bearing subset
    /// (the source-id space; see `lattice.rs`'s `raw_from_coords`). The caller
    /// recovers the original feature from `Supercluster::points[id]`.
    Point { feature_id: u32 },
}

impl Supercluster {
    /// `getClusters(bbox, zoom)` — the viewport query.
    ///
    /// Returns the Clusters and unclustered Points within `bbox` at the given
    /// Zoom Level, with antimeridian wrapping: a bbox crossing the
    /// international date line splits into eastern/western hemisphere queries
    /// whose results concatenate (matching `refs/supercluster/index.js` lines
    /// 89-102).
    ///
    /// `bbox` is `[min_lng, min_lat, max_lng, max_lat]` in degrees. Edge
    /// behavior matches supercluster: out-of-range longitudes wrap (mod 360),
    /// latitudes clamp to `[-90, 90]`, a >= 360° span collapses to the whole
    /// world, and non-integer `zoom` floors to integer before clamping to
    /// `[minZoom, maxZoom+1]`. Empty input yields an empty result.
    #[must_use]
    pub fn get_clusters(&self, bbox: &[f64; 4], zoom: f64) -> Vec<ClusterFeature> {
        // --- bbox normalization (supercluster lines 90-93) -------------------
        // Longitude wraps modulo 360 into [-180, 180); latitude clamps to
        // [-90, 90]. `max_lng` keeps a literal 180 (the whole-world east edge)
        // as 180 rather than wrapping it to -180.
        let mut min_lng = wrap_lng(bbox[0]);
        let min_lat = bbox[1].clamp(-90.0, 90.0);
        let mut max_lng = if bbox[2] == 180.0 {
            180.0
        } else {
            wrap_lng(bbox[2])
        };
        let max_lat = bbox[3].clamp(-90.0, 90.0);

        // --- whole-world collapse + antimeridian split (lines 95-102) --------
        if bbox[2] - bbox[0] >= 360.0 {
            // A span of at least the whole world: query [-180, 180] in one go.
            min_lng = -180.0;
            max_lng = 180.0;
        } else if min_lng > max_lng {
            // The wrapped bbox crosses the antimeridian: split into an eastern
            // hemisphere query [min_lng, 180] and a western one [-180, max_lng],
            // concatenating results. supercluster recurses; we inline both
            // queries since the split is exactly two hemispheres.
            let eastern = self.query_hemisphere(min_lng, min_lat, 180.0, max_lat, zoom);
            let western = self.query_hemisphere(-180.0, min_lat, max_lng, max_lat, zoom);
            let mut out = Vec::with_capacity(eastern.len() + western.len());
            out.extend(eastern);
            out.extend(western);
            return out;
        }

        self.query_hemisphere(min_lng, min_lat, max_lng, max_lat, zoom)
    }

    /// `getClustersIds(bbox, zoom)` — the hybrid id+encoded viewport fast path
    /// (ticket 10). Same bbox normalization + antimeridian split as
    /// [`get_clusters`](Self::get_clusters), but emits a **hybrid** result:
    /// unclustered Points as their source-feature ids only (the main thread
    /// indexes its own already-held source features — zero per-row encode, zero
    /// JS object reconstruction), and Clusters as full [`ClusterFeature`]s
    /// (Clusters are synthesized inside WASM and have no source feature on the
    /// main thread, so their lng/lat/num_points/aggregated must still cross
    /// encoded — unavoidable). The WASM boundary encodes the cluster features
    /// via the existing [`encode_results`](crate::encode::encode_results).
    ///
    /// This bypasses the per-Point typed-array encode that dominates Point-dense
    /// viewports (the `getClusters_small` bottleneck: ~1289 Point rows where the
    /// baseline returns existing object refs and the encoded path pays ~0.8
    /// us/row). Point rows pay zero encode; Cluster rows (typically few) pay the
    /// same encode as `get_clusters`. Membership is identical to `get_clusters`
    /// (same lattice, same kd-tree `range` call) — the oracle compares membership,
    /// not output format.
    #[must_use]
    pub fn get_clusters_ids(&self, bbox: &[f64; 4], zoom: f64) -> (Vec<u32>, Vec<ClusterFeature>) {
        // --- bbox normalization (same as get_clusters) -----------------------
        let mut min_lng = wrap_lng(bbox[0]);
        let min_lat = bbox[1].clamp(-90.0, 90.0);
        let mut max_lng = if bbox[2] == 180.0 {
            180.0
        } else {
            wrap_lng(bbox[2])
        };
        let max_lat = bbox[3].clamp(-90.0, 90.0);

        if bbox[2] - bbox[0] >= 360.0 {
            min_lng = -180.0;
            max_lng = 180.0;
        } else if min_lng > max_lng {
            let (mut e_pt, mut e_cl) =
                self.query_hemisphere_ids(min_lng, min_lat, 180.0, max_lat, zoom);
            let (w_pt, w_cl) = self.query_hemisphere_ids(-180.0, min_lat, max_lng, max_lat, zoom);
            e_pt.extend(w_pt);
            e_cl.extend(w_cl);
            return (e_pt, e_cl);
        }

        self.query_hemisphere_ids(min_lng, min_lat, max_lng, max_lat, zoom)
    }

    /// The hybrid non-splitting query path: range the kd-tree, then split hits
    /// into point ids (`num_points == 1` — emitted as the source-feature id
    /// only, no `ClusterFeature` construction) and cluster features
    /// (`num_points > 1` — built via [`feature_at`](Self::feature_at), the same
    /// path `get_clusters` uses, so the cluster rows carry identical lng/lat/
    /// num_points/aggregated).
    fn query_hemisphere_ids(
        &self,
        min_lng: f64,
        min_lat: f64,
        max_lng: f64,
        max_lat: f64,
        zoom: f64,
    ) -> (Vec<u32>, Vec<ClusterFeature>) {
        let z = self.limit_zoom(zoom);
        let Some(lattice) = self.stack.get(z) else {
            return (Vec::new(), Vec::new());
        };

        let min_x = lng_x(min_lng);
        let min_y = lat_y(max_lat);
        let max_x = lng_x(max_lng);
        let max_y = lat_y(min_lat);

        let ids = lattice.range(min_x, min_y, max_x, max_y);
        let mut point_ids = Vec::with_capacity(ids.len());
        let mut cluster_features = Vec::new();
        for id in ids {
            let i = id as usize;
            // num_points > 1 => Cluster (built via feature_at, same as
            // get_clusters); else unclustered Point (id only — the main thread
            // indexes its source features, zero encode).
            if lattice.num_points[i] > 1 {
                cluster_features.push(self.feature_at(lattice, i));
            } else {
                point_ids.push(lattice.source_id[i]);
            }
        }
        (point_ids, cluster_features)
    }

    /// The non-splitting query path: limit the zoom, range the kd-tree over
    /// the projected bbox, and emit one [`ClusterFeature`] per hit.
    ///
    /// `range` takes projected coordinates with y inverted relative to
    /// latitude (north = small y), so the query box is
    /// `(lng_x(min_lng), lat_y(max_lat), lng_x(max_lng), lat_y(min_lat))` —
    /// matching supercluster's `tree.range(lngX(minLng), latY(maxLat), ...)`.
    fn query_hemisphere(
        &self,
        min_lng: f64,
        min_lat: f64,
        max_lng: f64,
        max_lat: f64,
        zoom: f64,
    ) -> Vec<ClusterFeature> {
        let z = self.limit_zoom(zoom);
        let Some(lattice) = self.stack.get(z) else {
            // A zoom with no built lattice (e.g. below minZoom in a sparse
            // stack) yields no results, matching supercluster's `this.trees[z]`
            // being undefined -> `tree.range` would throw; we return empty.
            return Vec::new();
        };

        let min_x = lng_x(min_lng);
        let min_y = lat_y(max_lat);
        let max_x = lng_x(max_lng);
        let max_y = lat_y(min_lat);

        let ids = lattice.range(min_x, min_y, max_x, max_y);
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let i = id as usize;
            // num_points > 1 => Cluster; else unclustered Point (supercluster's
            // `data[k + OFFSET_NUM] > 1` branch, line 110).
            out.push(self.feature_at(lattice, i));
        }
        out
    }

    /// Build a [`ClusterFeature`] for lattice entry `i`: a Cluster (with its
    /// finalized aggregated values, ticket 06) if `num_points > 1`, else an
    /// unclustered Point. Shared by `get_clusters`'s viewport extraction and
    /// `get_children`'s drill-down so both surface aggregated properties
    /// identically.
    pub(crate) fn feature_at(
        &self,
        lattice: &crate::lattice::Lattice,
        i: usize,
    ) -> ClusterFeature {
        if lattice.num_points[i] > 1 {
            // Finalize the cluster's aggregated values from its accumulator
            // row: one `(name, value)` per spec field, in spec order.
            // `AggState::value()` does the per-op finalization (mean =
            // sum/count). Empty when the index was built with no spec — the
            // cluster then carries `point_count` only.
            let aggregated: Vec<(String, f64)> = self
                .stack
                .spec
                .iter()
                .zip(lattice.acc_row(i).iter().copied())
                .map(|(f, s)| (f.name.to_string(), s.value()))
                .collect();
            ClusterFeature {
                x: lattice.x[i],
                y: lattice.y[i],
                kind: FeatureKind::Cluster {
                    cluster_id: lattice.source_id[i],
                    num_points: lattice.num_points[i],
                    aggregated,
                },
            }
        } else {
            ClusterFeature {
                x: lattice.x[i],
                y: lattice.y[i],
                kind: FeatureKind::Point {
                    feature_id: lattice.source_id[i],
                },
            }
        }
    }

    /// `_limitZoom(z)` — floor to integer, then clamp to `[minZoom, maxZoom+1]`.
    ///
    /// A direct port of supercluster's `_limitZoom` (line 273-275):
    /// `Math.max(minZoom, Math.min(Math.floor(+z), maxZoom + 1))`. Non-integer
    /// zooms floor (Q16); zooms above `maxZoom+1` clamp down to `maxZoom+1`
    /// (the raw-point lattice); zooms below `minZoom` clamp up to `minZoom`.
    #[must_use]
    pub fn limit_zoom(&self, zoom: f64) -> i32 {
        let floored = zoom.floor() as i32;
        floored.clamp(self.options.min_zoom, self.options.max_zoom + 1)
    }
}

/// Wrap a longitude into `[-180, 180)` via `((x + 180) % 360 + 360) % 360 - 180`.
///
/// Matches supercluster's `minLng`/`maxLng` normalization (lines 90, 92). The
/// double-modulo handles negative inputs (Rust's `%` is remainder, not modulo,
/// so a negative dividend yields a negative result; adding 360 and re-moduloing
/// folds it into `[0, 360)` like JS's `%`).
fn wrap_lng(lng: f64) -> f64 {
    (((lng + 180.0) % 360.0 + 360.0) % 360.0) - 180.0
}

// ===========================================================================
// Membership recovery (oracle support, ticket 04)
// ===========================================================================
//
// The semantic-equivalence oracle compares Cluster *membership* per zoom —
// which source Points end up in the same Cluster — not cluster ids. Recovering
// a Cluster's member source-ids is the job of `getLeaves` (ticket 05), but the
// oracle needs membership *now* to verify `get_clusters`. Rather than pull 05's
// public API forward (scope creep), we recover membership *internally* by
// walking the same `parent_id` hierarchy `getLeaves` will expose: a Cluster at
// zoom `z` originates at some point `origin_index` at `z+1` (decoded from its
// cluster_id), and its children are the entries at `z+1` whose `parent_id`
// matches the cluster's id — recurse to the raw lattice for leaves.
//
// This is the same data `getLeaves` reads; it is just not the public 05 surface.

impl Supercluster {
    /// Extract the full Cluster Lattice at `zoom` as a list of source-point-id
    /// memberships — one sorted array per top-level Cluster or unclustered
    /// Point, matching the JS oracle's `extractClusterLattice` output shape.
    ///
    /// Queries the whole-world bbox `[-180, -90, 180, 90]` so the result is the
    /// complete lattice, not a viewport slice (matching the JS adapter). Each
    /// returned [`ClusterFeature`] becomes one membership: a singleton for an
    /// unclustered Point, or the Cluster's full leaf set for a Cluster.
    ///
    /// This is the Rust half of the oracle's `extractMembership`: it produces
    /// the membership the oracle's `diffMemberships` multiset-compares against
    /// the JS supercluster fixtures.
    #[must_use]
    pub fn extract_membership(&self, zoom: i32) -> Vec<Vec<u32>> {
        let features = self.get_clusters(&[-180.0, -90.0, 180.0, 90.0], f64::from(zoom));
        // Build a parent_id -> child-lattice-indices index for every zoom a
        // cluster originating at `zoom` could recurse into (its origin zoom
        // `zoom+1` down to the raw lattice `maxZoom+1`). This turns each
        // `append_leaves` child scan from an O(n) full-lattice sweep into an
        // O(children) direct lookup — the difference between a 100k-point
        // extraction finishing in milliseconds vs. minutes. Built once per
        // `extract_membership` call and shared across every top-level cluster
        // at this zoom, since they all recurse through the same origin lattices.
        let child_index = self.child_index_for(zoom);
        let mut out = Vec::with_capacity(features.len());
        for f in features {
            match f.kind {
                FeatureKind::Point { feature_id } => out.push(vec![feature_id]),
                FeatureKind::Cluster { cluster_id, .. } => {
                    let mut members = self.cluster_leaves(cluster_id, &child_index);
                    members.sort_unstable();
                    members.dedup();
                    if !members.is_empty() {
                        out.push(members);
                    }
                }
            }
        }
        out
    }

    /// Build the `parent_id -> Vec<child lattice index>` index for every zoom
    /// in `[zoom+1, maxZoom+1]` — the origin lattices a cluster at `zoom`
    /// recurses through when recovering its leaves. A `cluster_id` keys into
    /// the index at its origin zoom; the value is the list of lattice entries
    /// whose `parent_id` equals it (its direct children).
    ///
    /// One pass per lattice (O(n) total across the stack), built once and
    /// reused for every cluster at this zoom. Without this, `append_leaves`
    /// would re-scan the whole origin lattice per cluster — O(n) per cluster,
    /// O(n²) per zoom.
    fn child_index_for(&self, zoom: i32) -> Vec<HashMap<u32, Vec<usize>>> {
        // Index by zoom slot; only the slots in [zoom+1, maxZoom+1] are filled.
        let max_slot = (self.options.max_zoom + 1) as usize;
        let mut idx: Vec<HashMap<u32, Vec<usize>>> = (0..=max_slot).map(|_| HashMap::new()).collect();
        for z in (zoom + 1)..=self.options.max_zoom + 1 {
            let Some(lattice) = self.stack.get(z) else { continue };
            let entry = &mut idx[z as usize];
            for k in 0..lattice.len() {
                // NO_PARENT (top-level) entries have no children; skip them so
                // the index only holds real parent->child edges.
                let p = lattice.parent_id[k];
                if p != crate::lattice::NO_PARENT {
                    entry.entry(p).or_default().push(k);
                }
            }
        }
        idx
    }

    /// Recover the source-point ids of a Cluster's leaves by walking the
    /// `parent_id` chain down the lattice stack — the internal counterpart of
    /// `getLeaves` (ticket 05).
    ///
    /// A Cluster's id encodes its origin point index and origin zoom
    /// (`cluster_id.rs`). Its children are the entries at `origin_zoom` whose
    /// `parent_id` equals the cluster id; recurse into child Clusters until the
    /// raw lattice (`maxZoom+1`) is reached, where every entry is a leaf Point
    /// whose `source_id` is a source-feature id.
    ///
    /// `child_index` is the prebuilt parent_id -> children map (one entry per
    /// zoom slot); it makes the child lookup O(children) instead of an O(n)
    /// lattice scan. Built once per `extract_membership` call.
    ///
    /// Returns source-point ids in kd-tree/lattice traversal order (unsorted);
    /// the caller sorts+dedupes for the oracle's canonical membership key.
    fn cluster_leaves(
        &self,
        cluster_id: u32,
        child_index: &[HashMap<u32, Vec<usize>>],
    ) -> Vec<u32> {
        let (origin_index, origin_zoom) = crate::cluster_id::decode(cluster_id, self.stack.points_len);
        // The cluster's children live at its origin zoom (the zoom it was
        // created at, which is also `z+1` relative to the zoom it appears at as
        // a top-level entry). supercluster's `getChildren` reads
        // `this.trees[originZoom]`; `_getOriginZoom` returns `zoom + 1` (the
        // packed value), so `origin_zoom` here is already the lattice index.
        let mut leaves = Vec::new();
        self.append_leaves(&mut leaves, cluster_id, origin_index, origin_zoom, child_index);
        leaves
    }

    /// Recursive depth-first leaf collection, mirroring supercluster's
    /// `_appendLeaves` traversal shape (without its pagination — the oracle
    /// wants all leaves).
    ///
    /// Starting from the cluster's origin entry at `origin_zoom`, look up its
    /// children via the prebuilt `child_index` (an O(children) map lookup, not
    /// an O(n) lattice scan); each child is either a leaf (num_points == 1, at
    /// the raw lattice) or a sub-cluster to recurse into.
    fn append_leaves(
        &self,
        out: &mut Vec<u32>,
        cluster_id: u32,
        origin_index: usize,
        origin_zoom: i32,
        child_index: &[HashMap<u32, Vec<usize>>],
    ) {
        // The raw lattice (maxZoom+1) holds only leaf Points: a cluster id
        // never originates there, so reaching it means `origin_index` is a
        // leaf and we just collect it. (A cluster's origin zoom is always a
        // clustering zoom <= maxZoom, so this branch is the recursion's base
        // case only when a sub-cluster's origin is the raw lattice — which
        // cannot happen; the base case is the num_points==1 lookup below.)
        let Some(lattice) = self.stack.get(origin_zoom) else {
            // No lattice at this zoom (should not happen for a valid cluster
            // id): treat as a leaf with the origin's source_id if it is a raw
            // source id, else drop.
            if origin_index < self.stack.points_len {
                out.push(origin_index as u32);
            }
            return;
        };

        // Look up this cluster's children via the prebuilt index — the direct
        // counterpart of supercluster's `getChildren` scan (line 133:
        // `if (data[k + OFFSET_PARENT] === clusterId)`), but O(children) via
        // the map instead of an O(n) sweep of the whole lattice.
        let children = child_index
            .get(origin_zoom as usize)
            .and_then(|m| m.get(&cluster_id));
        let Some(children) = children else {
            // No children recorded: a cluster whose origin lattice had no
            // entries parented to it. Should not happen for a valid cluster id
            // (its origin point at least is parented to it), but treat as empty
            // rather than scanning.
            return;
        };
        for &k in children {
            if lattice.num_points[k] > 1 {
                // Sub-cluster: recurse into its children at its own origin zoom.
                let child_id = lattice.source_id[k];
                let (child_origin_index, child_origin_zoom) =
                    crate::cluster_id::decode(child_id, self.stack.points_len);
                self.append_leaves(
                    out,
                    child_id,
                    child_origin_index,
                    child_origin_zoom,
                    child_index,
                );
            } else {
                // Leaf point: its source_id is a source-feature id.
                out.push(lattice.source_id[k]);
            }
        }
    }
}

// ===========================================================================
// kd-tree range query lives on `Lattice` (in `lattice.rs`, next to `within`),
// since it reads the private `tree` field. The query half calls it via
// `lattice.range(...)`; see `Lattice::range`.
// ===========================================================================

use crate::supercluster::Supercluster;
