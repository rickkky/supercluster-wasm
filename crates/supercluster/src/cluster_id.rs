//! Internal cluster id encoding.
//!
//! supercluster encodes a cluster id as `((pointIndex << 5) + (zoom + 1) +
//! points.length)`, packing the originating point's index and zoom into a
//! single integer so `getChildren`/`getLeaves`/`getClusterExpansionZoom` can
//! recover them without a side table. The spec (cluster_id encoding decision)
//! says ids need only be **stable and drillable** — they are not *required*
//! to match supercluster's encoding, since the oracle compares membership,
//! not id values.
//!
//! We match supercluster's encoding anyway. The ticket-05 acceptance passes
//! **literal JS cluster ids** from `refs/supercluster/test/test.js`
//! (`getChildren(164)`, `getClusterExpansionZoom(4134)`, …) as direct
//! arguments, so Rust's ids must be numerically interchangeable with JS's.
//! Matching the encoding (same `<< 5`, same `zoom + 1`, same offset base)
//! is the cheapest way to make that true — no id-translation layer, and the
//! 04 membership oracle (which compares source-id multisets, not cluster ids)
//! stays green regardless.
//!
//! Layout: `cluster_id = points_len + (origin_index << ZOOM_BITS) | origin_zoom`
//! where `origin_zoom` is the zoom at which the cluster *originated* (the zoom
//! the build loop was running when it created the cluster), stored as
//! `zoom + 1` so the raw-point zoom (`Infinity`/maxZoom+1) never collides with
//! a real clustering zoom. `ZOOM_BITS = 5` matches supercluster, supporting
//! zooms `[0, 31]` — ample for `maxZoom` (default 16).
//!
//! The offset base is the **full input feature count** (`points.len()`,
//! including `geometry: null` features), matching supercluster's
//! `this.points.length`. supercluster skips `geometry: null` features on load
//! (its `if (!p.geometry) continue`), so the origin point index is a
//! geometry-bearing index `[0, geom_bearing)`, which is `< full count`; the
//! offset keeps cluster ids disjoint from source-feature ids `[0, full_count)`.

/// Number of bits packed for the origin zoom. Matches supercluster's `<< 5`;
/// supports zooms `[0, 31]`.
const ZOOM_BITS: u32 = 5;

/// Encode a cluster id from its origin point index, the zoom it originated at,
/// and the total source-feature count (the offset that keeps cluster ids
/// disjoint from source-feature ids).
///
/// `origin_zoom` is the *clustering* zoom (the loop variable), stored as
/// `zoom + 1` so that zoom 0 maps to the packed value 1 and the raw-point
/// lattice (zoom `maxZoom + 1`, never clustered) stays out of band.
///
/// `points_len` is the **full input feature count** (including `geometry:
/// null` features), matching supercluster's `this.points.length`, so the
/// encoded id is numerically identical to what JS supercluster would produce
/// for the same origin — see the module docs.
#[must_use]
pub fn encode(origin_index: usize, origin_zoom: i32, points_len: usize) -> u32 {
    let packed_zoom = (origin_zoom + 1) as u32;
    (points_len as u32) + ((origin_index as u32) << ZOOM_BITS) + packed_zoom
}

/// Decode a cluster id back into its origin point index and origin lattice
/// zoom.
///
/// The inverse of [`encode`]: strips the `points_len` offset, then splits the
/// remainder into the high `ZOOM_BITS`-bit origin index and the low 5-bit
/// packed zoom (stored as `zoom + 1`).
///
/// `points_len` must be the same value passed to [`encode`] when the id was
/// created (the full input feature count the index was built with). Passing a
/// different `points_len` yields a meaningless decode; the caller (the query
/// half) always has the built index's `points_len` in hand.
///
/// Returns `(origin_index, origin_lattice_zoom)` where `origin_lattice_zoom`
/// is the **lattice index** at which the cluster's children live — the packed
/// value `clustering_zoom + 1`, matching supercluster's `_getOriginZoom`
/// (`(clusterId - points.length) % 32`, which returns `zoom + 1`). A cluster
/// created by the clustering pass at zoom `z` absorbs its neighbors from the
/// lattice at `z + 1` (the pass's input lattice), so its children live at
/// lattice index `z + 1` — exactly what `getChildren`/`getLeaves` read via
/// `this.trees[originZoom]`. The raw lattice at `maxZoom + 1` never carries a
/// cluster id (no clustering pass runs there), so this is always a real
/// clustering lattice in `[minZoom + 1, maxZoom + 1]`.
#[must_use]
pub fn decode(cluster_id: u32, points_len: usize) -> (usize, i32) {
    let remainder = cluster_id.wrapping_sub(points_len as u32);
    let origin_index = (remainder >> ZOOM_BITS) as usize;
    let origin_lattice_zoom = remainder & ((1 << ZOOM_BITS) - 1);
    (origin_index, origin_lattice_zoom as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_ids_are_disjoint_from_source_feature_ids() {
        // Source-feature ids occupy [0, points_len). Every cluster id must be
        // >= points_len so the query half can tell a cluster from a point by
        // id alone (matching supercluster's `cluster_id >= points.length`).
        let points_len = 163;
        // The lowest possible cluster id (origin index 0, zoom 0).
        let lowest = encode(0, 0, points_len);
        assert!(
            (lowest as usize) >= points_len,
            "cluster id {lowest} collides with source-feature id space [0, {points_len})"
        );
    }

    #[test]
    fn distinct_origins_get_distinct_ids() {
        let points_len = 100;
        let a = encode(3, 5, points_len);
        let b = encode(4, 5, points_len);
        let c = encode(3, 6, points_len);
        assert_ne!(a, b, "different origin index must give different id");
        assert_ne!(a, c, "different origin zoom must give different id");
    }

    #[test]
    fn higher_zoom_increases_id_monotonically() {
        // Stored as `zoom + 1`, so a cluster originating at a higher zoom packs
        // a larger value than one at a lower zoom (same origin index).
        let points_len = 100;
        assert!(encode(7, 3, points_len) > encode(7, 2, points_len));
    }

    #[test]
    fn decode_is_the_inverse_of_encode() {
        // encode -> decode must recover the original origin index and the
        // origin *lattice* zoom (clustering zoom + 1) for a spread of inputs,
        // including the boundary zooms 0 and maxZoom.
        let points_len = 163;
        for (origin_index, clustering_zoom) in [
            (0usize, 0i32),
            (0, 6),
            (5, 3),
            (162, 0),
            (1000, 16),
        ] {
            let id = encode(origin_index, clustering_zoom, points_len);
            let (oi, lattice_zoom) = decode(id, points_len);
            assert_eq!(oi, origin_index, "index round-trip for ({origin_index}, {clustering_zoom})");
            assert_eq!(
                lattice_zoom,
                clustering_zoom + 1,
                "lattice zoom = clustering zoom + 1 for ({origin_index}, {clustering_zoom})"
            );
        }
    }

    #[test]
    fn decode_returns_origin_lattice_zoom_not_clustering_zoom() {
        // The packed zoom is `zoom + 1`, so decode yields the *lattice* index
        // where the cluster's children live — one above the clustering zoom.
        // A cluster created at clustering zoom 0 has children at lattice 1;
        // one created at maxZoom (16) has children at lattice 17 (maxZoom+1,
        // the raw lattice — the highest a cluster's children can live).
        let points_len = 50;
        assert_eq!(decode(encode(0, 0, points_len), points_len).1, 1);
        assert_eq!(decode(encode(0, 16, points_len), points_len).1, 17);
    }
}
