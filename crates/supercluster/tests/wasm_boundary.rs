//! Tier 2 (ticket 07): the `wasm-bindgen` boundary contract.
//!
//! "the typed array a WASM call returns decodes to the expected
//! id+coord+count+cluster/point-tag set for a given query" (spec, Testing
//! Decisions). These tests drive [`SuperclusterWasm`](supercluster::SuperclusterWasm)
//! through its public FFI surface in a headless browser and assert the
//! `Float64Array` result object decodes to the expected cluster/point set.
//!
//! They live in a dedicated integration-test file (not an inline `mod tests`)
//! because `wasm-bindgen-test` only collects `#[wasm_bindgen_test]` functions
//! declared at the crate root or within a `pub mod` — a private inline test
//! module registers zero tests with the harness. `required-features = ["wasm"]`
//! in `Cargo.toml`'s `[[test]]` entry keeps this file from compiling under the
//! plain native `cargo test` run (Tier 1).

#![cfg(feature = "wasm")]

use js_sys::{Array, Float64Array, Object, Reflect, Uint32Array};
use supercluster::encode::{ROW_STRIDE, TAG_CLUSTER, TAG_POINT};
use supercluster::wasm::SuperclusterWasm;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_test::*;

/// Set a key on a JS object from any `Into<JsValue>`.
fn js_set(obj: &Object, key: &str, val: impl Into<JsValue>) {
    let _ = Reflect::set(obj, &key.into(), &val.into());
}

/// A tiny GeoJSON FeatureCollection: three co-located points (cluster) +
/// one far singleton (point). Built as a JS object via `js-sys`.
fn tiny_collection() -> JsValue {
    let fc = Object::new();
    js_set(&fc, "type", "FeatureCollection");
    let features = Array::new();
    for (lng, lat) in [(0.0, 0.0), (0.001, 0.001), (-0.001, 0.0)] {
        let f = Object::new();
        js_set(&f, "type", "Feature");
        let geom = Object::new();
        js_set(&geom, "type", "Point");
        let coords = Array::new();
        coords.push(&lng.into());
        coords.push(&lat.into());
        js_set(&geom, "coordinates", coords);
        js_set(&f, "geometry", geom);
        js_set(&f, "properties", Object::new());
        features.push(&f.into());
    }
    // A far singleton — its own point at zoom 0.
    let f = Object::new();
    js_set(&f, "type", "Feature");
    let geom = Object::new();
    js_set(&geom, "type", "Point");
    let coords = Array::new();
    coords.push(&100.0.into());
    coords.push(&50.0.into());
    js_set(&geom, "coordinates", coords);
    js_set(&f, "geometry", geom);
    js_set(&f, "properties", Object::new());
    features.push(&f.into());

    js_set(&fc, "features", features);
    fc.into()
}

/// Read the `count` field off a `get_clusters`/`get_children` result object.
fn count_of(res: &JsValue) -> f64 {
    let obj = res.dyn_ref::<Object>().unwrap();
    Reflect::get(obj, &"count".into()).unwrap().as_f64().unwrap()
}

/// A tiny collection whose spec field `name` differs from the source `prop`
/// (`{name: "total", prop: "value", op: "sum"}`). Regression for the
/// `build_point_features` sidecar-key bug: it stored under the spec field's
/// output `name`, but the build loop seeds accumulators via
/// `get_numeric(spec_field.prop)` — a name/prop mismatch made every fold read
/// the identity (sum 0). The three co-located points carry values 5/7/100, so
/// the zoom-0 cluster must fold to 112.
fn tiny_collection_with_values() -> JsValue {
    let fc = Object::new();
    js_set(&fc, "type", "FeatureCollection");
    let features = Array::new();
    for ((lng, lat), value) in [
        ((0.0, 0.0), 5.0),
        ((0.001, 0.001), 7.0),
        ((-0.001, 0.0), 100.0),
        ((100.0, 50.0), 1.0),
    ] {
        let f = Object::new();
        js_set(&f, "type", "Feature");
        let geom = Object::new();
        js_set(&geom, "type", "Point");
        let coords = Array::new();
        coords.push(&lng.into());
        coords.push(&lat.into());
        js_set(&geom, "coordinates", coords);
        js_set(&f, "geometry", geom);
        let props = Object::new();
        js_set(&props, "value", value);
        js_set(&f, "properties", props);
        features.push(&f.into());
    }
    js_set(&fc, "features", features);
    fc.into()
}

/// Load `tiny_collection_with_values` with the name≠prop spec; returns the
/// index and the zoom-0 query result object. The caller must keep the index
/// alive while reading the returned `Float64Array` views (they alias its
/// per-query buffers).
fn load_with_values_and_query_zoom0() -> (SuperclusterWasm, JsValue) {
    let mut s = SuperclusterWasm::new();
    let opts = Object::new();
    js_set(&opts, "maxZoom", 6.0);
    let agg = Object::new();
    let fields = Array::new();
    let field = Object::new();
    js_set(&field, "name", "total");
    js_set(&field, "prop", "value");
    js_set(&field, "op", "sum");
    fields.push(&field.into());
    js_set(&agg, "fields", fields);
    js_set(&opts, "aggregation", agg);
    s.load(&tiny_collection_with_values(), &opts.into())
        .expect("load must succeed");

    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    (s, res)
}

#[wasm_bindgen_test]
fn new_is_empty_and_queries_return_zero() {
    let mut s = SuperclusterWasm::new();
    assert_eq!(s.get_cluster_expansion_zoom(0), 0);
    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    assert_eq!(count_of(&res), 0.0);
}

#[wasm_bindgen_test]
fn load_and_get_clusters_decodes_to_cluster_plus_point() {
    let mut s = SuperclusterWasm::new();
    let opts = Object::new();
    js_set(&opts, "maxZoom", 6.0);
    s.load(&tiny_collection(), &opts.into()).expect("load must succeed");

    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let obj = res.dyn_ref::<Object>().unwrap();
    let count = Reflect::get(obj, &"count".into()).unwrap().as_f64().unwrap();
    assert!(count >= 2.0, "expected at least a cluster + a point, got {count}");

    let rows_val = Reflect::get(obj, &"rows".into()).unwrap();
    let rows = rows_val.dyn_ref::<Float64Array>().unwrap();
    assert_eq!(rows.length() as usize, count as usize * ROW_STRIDE);

    // Decode each row: collect tags. There must be at least one cluster
    // (tag 1) and at least one point (tag 0) — the boundary contract.
    let n = count as usize;
    let v = rows.to_vec();
    let mut has_cluster = false;
    let mut has_point = false;
    for i in 0..n {
        let tag = v[i * ROW_STRIDE + 4];
        if tag == TAG_CLUSTER {
            has_cluster = true;
        } else if tag == TAG_POINT {
            has_point = true;
        }
    }
    assert!(has_cluster, "expected at least one cluster (tag=1)");
    assert!(has_point, "expected at least one point (tag=0)");
}

#[wasm_bindgen_test]
fn empty_load_builds_empty_index() {
    let mut s = SuperclusterWasm::new();
    let empty = Array::new(); // plain empty array
    s.load(&empty.into(), &JsValue::undefined()).expect("empty load must not throw");
    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    assert_eq!(count_of(&res), 0.0, "empty index -> zero results");
}

#[wasm_bindgen_test]
fn load_coords_builds_same_clusters_as_load() {
    // The same 4 points as `tiny_collection`, pre-flattened to
    // [lng, lat, lng, lat, ...]. `load_coords` is the fast path: one
    // passArrayF64ToWasm0 copy, pure-Rust build, zero per-feature Reflect::get
    // FFI. It must produce the same zoom-0 cluster/point membership as `load`.
    let mut s = SuperclusterWasm::new();
    let opts = Object::new();
    js_set(&opts, "maxZoom", 6.0);
    let flat = Float64Array::new_with_length(8);
    flat.copy_from(&[0.0, 0.0, 0.001, 0.001, -0.001, 0.0, 100.0, 50.0]);
    s.load_coords(&flat, &opts.into())
        .expect("load_coords must succeed");

    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let obj = res.dyn_ref::<Object>().unwrap();
    let count = Reflect::get(obj, &"count".into()).unwrap().as_f64().unwrap();
    assert!(count >= 2.0, "expected at least a cluster + a point, got {count}");

    let rows_val = Reflect::get(obj, &"rows".into()).unwrap();
    let rows = rows_val.dyn_ref::<Float64Array>().unwrap();
    assert_eq!(rows.length() as usize, count as usize * ROW_STRIDE);

    // Membership parity with `load`: at least one cluster + one point.
    let v = rows.to_vec();
    let mut has_cluster = false;
    let mut has_point = false;
    for i in 0..count as usize {
        let tag = v[i * ROW_STRIDE + 4];
        if tag == TAG_CLUSTER {
            has_cluster = true;
        } else if tag == TAG_POINT {
            has_point = true;
        }
    }
    assert!(has_cluster, "load_coords: expected at least one cluster (tag=1)");
    assert!(has_point, "load_coords: expected at least one point (tag=0)");
}

#[wasm_bindgen_test]
fn load_coords_empty_builds_empty_index() {
    let mut s = SuperclusterWasm::new();
    let empty = Float64Array::new_with_length(0);
    s.load_coords(&empty, &JsValue::undefined())
        .expect("empty load_coords must not throw");
    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    assert_eq!(count_of(&res), 0.0, "empty index -> zero results");
}

#[wasm_bindgen_test]
fn load_coords_odd_length_throws() {
    // An odd-length flat array is malformed (a dangling lng with no lat).
    // `load_coords` must reject it with a thrown error, not silently drop the
    // last value or read out of bounds.
    let mut s = SuperclusterWasm::new();
    let odd = Float64Array::new_with_length(3);
    odd.copy_from(&[1.0, 2.0, 3.0]);
    let result = s.load_coords(&odd, &JsValue::undefined());
    assert!(result.is_err(), "odd-length coords must error");
}

#[wasm_bindgen_test]
fn get_clusters_ids_splits_points_and_clusters() {
    // The hybrid id+encoded fast path (ticket 10) must return the same
    // Point/Cluster split as the encoded `get_clusters` path: every Point row's
    // feature_id lands in `point_ids` (Uint32Array), every Cluster row is
    // encoded into `cluster_rows` (Float64Array, stride 5) + `cluster_aggregated`,
    // and the union count equals the encoded path's row count. The cluster rows
    // must decode identically to the encoded path's cluster rows (same encoder,
    // same `feature_at` path — the hybrid path is an output-format change, not an
    // algorithm change).
    let mut s = SuperclusterWasm::new();
    let opts = Object::new();
    js_set(&opts, "maxZoom", 6.0);
    s.load(&tiny_collection(), &opts.into()).expect("load must succeed");

    let bbox = [-180.0, -90.0, 180.0, 90.0];
    let enc = s.get_clusters(&bbox, 0.0);
    let enc_obj = enc.dyn_ref::<Object>().unwrap();
    let enc_count = Reflect::get(enc_obj, &"count".into()).unwrap().as_f64().unwrap() as usize;
    let enc_rows = Reflect::get(enc_obj, &"rows".into())
        .unwrap()
        .dyn_ref::<Float64Array>()
        .unwrap()
        .to_vec();

    let ids = s.get_clusters_ids(&bbox, 0.0);
    let ids_obj = ids.dyn_ref::<Object>().unwrap();
    let pt = Reflect::get(ids_obj, &"point_ids".into())
        .unwrap()
        .dyn_ref::<Uint32Array>()
        .unwrap()
        .to_vec();
    let cluster_rows = Reflect::get(ids_obj, &"cluster_rows".into())
        .unwrap()
        .dyn_ref::<Float64Array>()
        .unwrap()
        .to_vec();
    let cluster_aggregated = Reflect::get(ids_obj, &"cluster_aggregated".into())
        .unwrap()
        .dyn_ref::<Float64Array>()
        .unwrap()
        .to_vec();
    let count = Reflect::get(ids_obj, &"count".into()).unwrap().as_f64().unwrap() as usize;
    let spec_len = Reflect::get(ids_obj, &"specLen".into()).unwrap().as_f64().unwrap() as usize;

    // The cluster rows are stride-5; their count is rows.len() / ROW_STRIDE.
    let cluster_count = cluster_rows.len() / ROW_STRIDE;
    // Union count matches the encoded path.
    assert_eq!(count, pt.len() + cluster_count);
    assert_eq!(count, enc_count, "ids count must equal encoded count");

    // Collect the encoded path's point feature_ids and cluster cluster_ids,
    // then assert the hybrid path split them identically (as sets).
    let mut enc_pt: Vec<u32> = Vec::new();
    let mut enc_cl: Vec<u32> = Vec::new();
    for i in 0..enc_count {
        let tag = enc_rows[i * ROW_STRIDE + 4];
        let id = enc_rows[i * ROW_STRIDE + 2] as u32;
        if tag == TAG_POINT {
            enc_pt.push(id);
        } else if tag == TAG_CLUSTER {
            enc_cl.push(id);
        }
    }
    let sort_set = |v: Vec<u32>| {
        let mut s = v;
        s.sort_unstable();
        s.dedup();
        s
    };
    assert_eq!(sort_set(pt), sort_set(enc_pt), "point_ids must match encoded point feature_ids");
    assert_eq!(cluster_count, enc_cl.len(), "cluster_rows count must match encoded cluster count");
    // The cluster_id is column index 2 (id) of each stride-5 row.
    let hybrid_cl: Vec<u32> = (0..cluster_count).map(|i| cluster_rows[i * ROW_STRIDE + 2] as u32).collect();
    assert_eq!(sort_set(hybrid_cl), sort_set(enc_cl), "cluster_rows cluster_ids must match encoded cluster cluster_ids");

    // The cluster rows must decode identically to the encoded path's cluster
    // rows: same encoder, same `feature_at` path. Compare the encoded cluster
    // rows (extracted from the full encoded rows) against the hybrid cluster
    // rows, value-by-value.
    let mut enc_cluster_rows: Vec<f64> = Vec::with_capacity(cluster_count * ROW_STRIDE);
    for i in 0..enc_count {
        let tag = enc_rows[i * ROW_STRIDE + 4];
        if tag == TAG_CLUSTER {
            for j in 0..ROW_STRIDE {
                enc_cluster_rows.push(enc_rows[i * ROW_STRIDE + j]);
            }
        }
    }
    // The hybrid cluster rows may be in a different order than the encoded path
    // (the lattice scan order is the same, but the encoded path interleaves
    // points+clusters while the hybrid path separates them). Compare as sorted
    // multisets of stride-5 rows (lexicographic on the f64 columns).
    let row_cmp = |a: &Vec<f64>, b: &Vec<f64>| -> std::cmp::Ordering {
        for (x, y) in a.iter().zip(b.iter()) {
            match x.partial_cmp(y) {
                Some(std::cmp::Ordering::Equal) => continue,
                Some(o) => return o,
                None => return std::cmp::Ordering::Equal,
            }
        }
        a.len().cmp(&b.len())
    };
    let mut enc_sorted = enc_cluster_rows.chunks(ROW_STRIDE).map(|c| c.to_vec()).collect::<Vec<_>>();
    enc_sorted.sort_unstable_by(row_cmp);
    let mut hybrid_sorted = cluster_rows.chunks(ROW_STRIDE).map(|c| c.to_vec()).collect::<Vec<_>>();
    hybrid_sorted.sort_unstable_by(row_cmp);
    assert_eq!(hybrid_sorted, enc_sorted, "cluster_rows must decode identically to encoded cluster rows");
    // The aggregated buffer is spec_len per cluster; with no aggregation spec
    // (spec_len == 0) both are empty.
    assert_eq!(cluster_aggregated.len(), cluster_count * spec_len);
    assert_eq!(spec_len, 0, "no aggregation spec -> spec_len 0");
}

#[wasm_bindgen_test]
fn get_clusters_ids_empty_when_not_loaded() {
    // The hybrid empty shape (ticket 10): all five fields present, zero count,
    // zero-length typed arrays. The main-thread decode reads `count` first and
    // short-circuits, but the contract must still surface every field so the
    // decode path never branches on field presence.
    let mut s = SuperclusterWasm::new();
    let res = s.get_clusters_ids(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let obj = res.dyn_ref::<Object>().unwrap();
    let count = Reflect::get(obj, &"count".into()).unwrap().as_f64().unwrap();
    assert_eq!(count, 0.0, "not-loaded -> zero count");
    let pt = Reflect::get(obj, &"point_ids".into()).unwrap();
    assert_eq!(pt.dyn_ref::<Uint32Array>().unwrap().length(), 0);
    let cl_rows = Reflect::get(obj, &"cluster_rows".into()).unwrap();
    assert_eq!(cl_rows.dyn_ref::<Float64Array>().unwrap().length(), 0);
    let cl_agg = Reflect::get(obj, &"cluster_aggregated".into()).unwrap();
    assert_eq!(cl_agg.dyn_ref::<Float64Array>().unwrap().length(), 0);
    let spec_len = Reflect::get(obj, &"specLen".into()).unwrap().as_f64().unwrap();
    assert_eq!(spec_len, 0.0, "not-loaded -> spec_len 0");
}

#[wasm_bindgen_test]
fn get_children_and_expansion_zoom_run() {
    let mut s = SuperclusterWasm::new();
    let opts = Object::new();
    js_set(&opts, "maxZoom", 6.0);
    s.load(&tiny_collection(), &opts.into()).expect("load must succeed");

    // Find a cluster id from the zoom-0 viewport, then drill into it.
    let res = s.get_clusters(&[-180.0, -90.0, 180.0, 90.0], 0.0);
    let obj = res.dyn_ref::<Object>().unwrap();
    let rows_val = Reflect::get(obj, &"rows".into()).unwrap();
    let rows = rows_val.dyn_ref::<Float64Array>().unwrap();
    let count = Reflect::get(obj, &"count".into()).unwrap().as_f64().unwrap() as usize;
    let v = rows.to_vec();

    let mut cluster_id: Option<u32> = None;
    for i in 0..count {
        let tag = v[i * ROW_STRIDE + 4];
        if tag == TAG_CLUSTER {
            cluster_id = Some(v[i * ROW_STRIDE + 2] as u32);
            break;
        }
    }
    let cid = cluster_id.expect("expected at least one cluster to drill into");

    // getChildren returns a result object (no throw on valid id).
    let children_res = s.get_children(cid);
    let _ = count_of(&children_res);

    // getClusterExpansionZoom returns a plain i32.
    let z = s.get_cluster_expansion_zoom(cid);
    assert!(z >= 0, "expansion zoom must be non-negative, got {z}");

    // Invalid id: no throw, returns empty.
    let bad = s.get_children(u32::MAX);
    assert_eq!(count_of(&bad), 0.0, "invalid cluster_id -> empty result, no throw");
}

#[wasm_bindgen_test]
fn aggregation_sidecar_keyed_by_source_prop_not_spec_name() {
    // Regression for the sidecar-key bug (see the helper doc above): the
    // cluster over values 5/7/100 must fold to 112, not the identity.
    let (s, res) = load_with_values_and_query_zoom0();
    let obj = res.dyn_ref::<Object>().unwrap();
    let count = count_of(&res);
    let spec_len = Reflect::get(obj, &"specLen".into()).unwrap().as_f64().unwrap();
    assert_eq!(spec_len, 1.0, "spec must parse");
    let agg_val = Reflect::get(obj, &"aggregated".into()).unwrap();
    let agg = agg_val.dyn_ref::<Float64Array>().unwrap().to_vec();
    assert_eq!(agg.len(), 1, "one cluster * specLen 1 (count={count}, agg={agg:?})");
    assert!(
        (agg[0] - 112.0).abs() < 1e-9,
        "cluster sum must fold 5+7+100=112, got {}",
        agg[0]
    );
}
