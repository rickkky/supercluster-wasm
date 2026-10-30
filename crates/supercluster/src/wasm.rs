//! The `wasm-bindgen` boundary (ticket 07): the FFI shell over the pure-Rust
//! clustering API.
//!
//! [`SuperclusterWasm`] wraps a [`Supercluster`](crate::Supercluster) index and
//! exposes `load` / `get_clusters` / `get_children` / `get_leaves` /
//! `get_cluster_expansion_zoom` to JS. Query results cross the boundary as
//! compact `Float64Array`s produced by [`encode_results`](crate::encode::encode_results)
//! — the pure-Rust encoder (sub-seam B) that this shell is a thin caller of.
//! The index stays opaque in WASM linear memory (ADR 0002); only result data
//! crosses.
//!
//! # Per-query buffer lifetime (aliasing safety)
//!
//! Each query method runs `encode_results` into **fresh** `Vec<f64>`s, stores
//! them on `self` (dropping the previous query's buffers), and returns
//! `Float64Array::view`s into the new buffers. The previous view is invalidated
//! (its backing buffer dropped). This is safe because the Web Worker copies
//! each view into a fresh `Float64Array` and transfers that copy before the
//! next query — there is no scratch-buffer reuse across queries, avoiding
//! `Float64Array::view` aliasing UB given variable result sizes (spec Q10).
//!
//! # GeoJSON parsing
//!
//! `load` parses GeoJSON via `js-sys` (the crate stays serde-free in release)
//! and builds [`PointFeature`](crate::feature::PointFeature)s field-by-field.
//! This is where the ticket-06-deferred `numeric_props` sidecar is populated:
//! for each spec field, the named property is read off the feature's
//! `properties` object so the build loop folds aggregations with zero JSON
//! parsing on the hot path. `properties` itself is left `None` — the main
//! thread keeps the original GeoJSON features for rendering unclustered points
//! (the build loop never reads `properties`).
//!
//! # `load_coords` fast path (ticket 08)
//!
//! `load_coords(&Float64Array, &JsValue)` is the data-driven fast path: a
//! pre-flattened `[lng, lat, ...]` array crosses the boundary with a single
//! `passArrayF64ToWasm0` copy, then a pure-Rust build runs with zero
//! per-feature `Reflect::get` FFI. The GeoJSON parse that dominates `load`
//! (measured ~1.5 us/feature of FFI overhead — the load bottleneck, independent
//! of data distribution) is bypassed entirely. `load` stays for GeoJSON
//! compatibility; `load_coords` for callers who control the input pipeline.

use crate::aggregation::{AggOp, AggregationSpec};
use crate::encode::encode_results;
use crate::feature::PointFeature;
use crate::options::Options;
use crate::supercluster::Supercluster;
use js_sys::{Array, Float64Array, Object, Reflect, Uint32Array};
use wasm_bindgen::{JsCast, JsValue, prelude::*};

/// Tag values for the `kind` discriminator on a JS-built aggregation field.
/// Mirrors [`AggOp`] so a JS caller spells the op as a plain string.
const OP_SUM: &str = "sum";
const OP_COUNT: &str = "count";
const OP_MIN: &str = "min";
const OP_MAX: &str = "max";
const OP_MEAN: &str = "mean";

/// The WASM-exposed clustering index. Holds the built [`Supercluster`] and the
/// per-query result buffers that `Float64Array::view`/`Uint32Array::view`
/// borrows.
#[wasm_bindgen]
pub struct SuperclusterWasm {
    index: Option<Supercluster>,
    row_buf: Vec<f64>,
    agg_buf: Vec<f64>,
    /// Per-query id buffer for the `get_clusters_ids` hybrid fast path (ticket
    /// 10): the source-feature ids of the unclustered Point rows. Same lifetime
    /// discipline as `row_buf`/`agg_buf`: overwritten each call.
    point_id_buf: Vec<u32>,
    spec_len: usize,
}

#[wasm_bindgen]
impl SuperclusterWasm {
    /// Create an empty wrapper (no index loaded yet). Queries before `load`
    /// return empty results rather than throwing.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            index: None,
            row_buf: Vec::new(),
            agg_buf: Vec::new(),
            point_id_buf: Vec::new(),
            spec_len: 0,
        }
    }

    /// Build the index from GeoJSON features + options.
    ///
    /// `geojson` is either a `FeatureCollection` (`{type, features:[...]}`) or
    /// a plain array of features. `options` is a JS object with camelCase keys
    /// (`minZoom`, `maxZoom`, `minPoints`, `radius`, `extent`, `nodeSize`,
    /// `aggregation`); absent keys take supercluster's defaults.
    ///
    /// Returns `undefined` on success, or throws a `JsValue` error string on a
    /// parse failure. Empty input builds an empty index (no throw), matching
    /// supercluster's `load([])`.
    pub fn load(&mut self, geojson: &JsValue, options: &JsValue) -> Result<(), JsValue> {
        let features = parse_features(geojson)?;
        let (opts, spec_len) = parse_options(options)?;
        // The spec is cloned into Options; track its length so query results
        // decode the aggregated buffer with the right stride.
        let spec = opts.spec.clone();
        self.spec_len = spec_len;
        let points = build_point_features(&features, &spec)?;
        // `load` takes ownership of points + options; never panics on empty.
        self.index = Some(Supercluster::load(points, opts));
        Ok(())
    }

    /// Build the index from a pre-flattened `[lng, lat, lng, lat, ...]`
    /// coordinate array + options — the **fast path** (ticket 08, data-driven).
    ///
    /// One `passArrayF64ToWasm0` copy (the `Float64Array::to_vec` call) lands
    /// the coordinates in WASM linear memory, then a pure-Rust build runs with
    /// **zero per-feature `Reflect::get` FFI** — the GeoJSON parse that dominates
    /// `load` (measured ~1.5 us/feature of FFI overhead, the load bottleneck) is
    /// bypassed entirely. Use this when the caller controls the input pipeline
    /// (a flat typed array, no GeoJSON to parse); `load` stays for GeoJSON
    /// compatibility.
    ///
    /// `numeric_props` is not populated (a flat coordinate array carries no
    /// properties), so aggregation accumulators seed from nothing per feature —
    /// correct for the no-spec config; a spec that reads source properties
    /// contributes the identity (nothing), matching `load`'s missing-prop
    /// behavior. An odd-length array is rejected (a dangling coordinate with no
    /// pair), not silently truncated.
    pub fn load_coords(&mut self, coords: &Float64Array, options: &JsValue) -> Result<(), JsValue> {
        if coords.length() % 2 != 0 {
            return Err(JsValue::from_str(
                "load_coords: coordinate array length must be even (lng,lat pairs)",
            ));
        }
        // One copy: JS Float64Array -> WASM linear memory -> Rust Vec. This is
        // the only boundary crossing on the load hot path (vs `load`'s
        // per-feature Reflect::get x4).
        let flat = coords.to_vec();
        let (opts, spec_len) = parse_options(options)?;
        self.spec_len = spec_len;
        let points = build_point_features_from_coords(&flat);
        self.index = Some(Supercluster::load(points, opts));
        Ok(())
    }

    /// `getClusters(bbox, zoom)` — viewport query. `bbox` is
    /// `[minLng, minLat, maxLng, maxLat]`. Returns `{count, rows, aggregated,
    /// specLen}` where `rows`/`aggregated` are `Float64Array` views into the
    /// per-query buffers.
    pub fn get_clusters(&mut self, bbox: &[f64], zoom: f64) -> JsValue {
        let Some(index) = self.index.as_ref() else {
            return empty_result(self.spec_len);
        };
        // Coerce the JS bbox (any array-like) to the [f64;4] the query expects.
        let bbox4 = [bbox.first().copied().unwrap_or(0.0), bbox.get(1).copied().unwrap_or(0.0), bbox.get(2).copied().unwrap_or(0.0), bbox.get(3).copied().unwrap_or(0.0)];
        let features = index.get_clusters(&bbox4, zoom);
        self.encode_and_view(&features)
    }

    /// `getClustersIds(bbox, zoom)` — the hybrid id+encoded viewport fast path
    /// (ticket 10).
    ///
    /// Same viewport query as [`get_clusters`](Self::get_clusters), but returns
    /// a **hybrid** shape: `{point_ids: Uint32Array, cluster_rows: Float64Array,
    /// cluster_aggregated: Float64Array, count, specLen}`. Point rows are
    /// `point_ids` — the source-feature ids of the unclustered Points (the main
    /// thread indexes its own already-held source features by id — zero per-row
    /// encode, zero JS object reconstruction). Cluster rows are encoded via the
    /// existing [`encode_results`] into `cluster_rows` (stride 5) +
    /// `cluster_aggregated` (cluster-dense, stride `specLen`) — Clusters are
    /// synthesized inside WASM and have no source feature on the main thread, so
    /// their lng/lat/num_points/aggregated must still cross encoded (unavoidable).
    /// `count` = `point_ids.length + cluster_rows.length / ROW_STRIDE`.
    ///
    /// This bypasses the per-Point typed-array encode that dominates Point-dense
    /// viewports (the `getClusters_small` bottleneck, where the baseline returns
    /// existing object refs and the encoded path pays ~0.8 us/Point row). Use
    /// this when the caller renders unclustered points from its own source-
    /// feature array; use `get_clusters` when it needs the encoded lng/lat for
    /// points (e.g. a worker-wired decode path with no source features on the
    /// main thread). Membership is identical to `get_clusters` (same lattice,
    /// same kd-tree `range` call) — the oracle compares membership, not output
    /// format.
    pub fn get_clusters_ids(&mut self, bbox: &[f64], zoom: f64) -> JsValue {
        let Some(index) = self.index.as_ref() else {
            return empty_ids_result(self.spec_len);
        };
        let bbox4 = [bbox.first().copied().unwrap_or(0.0), bbox.get(1).copied().unwrap_or(0.0), bbox.get(2).copied().unwrap_or(0.0), bbox.get(3).copied().unwrap_or(0.0)];
        // The query returns Point rows as ids and Cluster rows as full
        // ClusterFeatures (built via the same feature_at path get_clusters uses,
        // so the cluster rows carry identical lng/lat/num_points/aggregated).
        let (point_ids, cluster_features) = index.get_clusters_ids(&bbox4, zoom);
        self.point_id_buf = point_ids;
        // Encode the cluster rows via the existing encoder (output-format change
        // only; the Cluster rows are already computed during the lattice scan).
        let (row_buf, agg_buf, cluster_count) = encode_results(&cluster_features, self.spec_len);
        self.row_buf = row_buf;
        self.agg_buf = agg_buf;
        let count = self.point_id_buf.len() + cluster_count;
        // SAFETY: the views borrow `self.point_id_buf`/`self.row_buf`/
        // `self.agg_buf`, which live as `&mut self` fields until the next query
        // overwrites them. The caller (main thread or worker) copies/uses them
        // before any subsequent call mutates these buffers.
        let (pt_view, rows_view, agg_view) = unsafe {
            (
                Uint32Array::view(&self.point_id_buf),
                Float64Array::view(&self.row_buf),
                Float64Array::view(&self.agg_buf),
            )
        };
        let obj = Object::new();
        js_set(&obj, "point_ids", pt_view);
        js_set(&obj, "cluster_rows", rows_view);
        js_set(&obj, "cluster_aggregated", agg_view);
        js_set(&obj, "count", count as f64);
        js_set(&obj, "specLen", self.spec_len as f64);
        obj.into()
    }

    /// `getChildren(clusterId)` — the direct children of a cluster, in kd-tree
    /// traversal order. Invalid ids return an empty result (no throw), matching
    /// the Rust crate's no-throw edge style.
    pub fn get_children(&mut self, cluster_id: u32) -> JsValue {
        let Some(index) = self.index.as_ref() else {
            return empty_result(self.spec_len);
        };
        let features = index.get_children(cluster_id);
        self.encode_and_view(&features)
    }

    /// `getLeaves(clusterId, limit, offset)` — paginated leaves. `limit` is
    /// `Some(n)` for a finite page or `None` for all leaves (JS `Infinity`).
    pub fn get_leaves(&mut self, cluster_id: u32, limit: Option<usize>, offset: usize) -> JsValue {
        let Some(index) = self.index.as_ref() else {
            return empty_result(self.spec_len);
        };
        let features = index.get_leaves(cluster_id, limit, offset);
        self.encode_and_view(&features)
    }

    /// `getClusterExpansionZoom(clusterId)` — the lowest zoom where the cluster
    /// breaks into >1 child (`maxZoom + 1` if it never does). Direct `i32`
    /// return; no typed arrays.
    pub fn get_cluster_expansion_zoom(&self, cluster_id: u32) -> i32 {
        self.index
            .as_ref()
            .map(|i| i.get_cluster_expansion_zoom(cluster_id))
            .unwrap_or(0)
    }
}

impl SuperclusterWasm {
    /// Run the encoder over a query's features, store the fresh buffers on
    /// `self`, and return the JS result object with `Float64Array::view`s into
    /// them. The previous query's buffers are dropped (no aliasing).
    fn encode_and_view(&mut self, features: &[crate::query::ClusterFeature]) -> JsValue {
        let (row_buf, agg_buf, count) = encode_results(features, self.spec_len);
        self.row_buf = row_buf;
        self.agg_buf = agg_buf;
        // Build the JS object {count, rows, aggregated, specLen}. The views
        // borrow `self.row_buf`/`self.agg_buf` — valid until the next query
        // replaces them. The Worker copies + transfers before that happens.
        // SAFETY: the views borrow `self.row_buf`/`self.agg_buf`, which live as
        // `&mut self` fields for the duration of this call and until the next
        // query replaces them. The Worker is the sole consumer and copies the
        // data out before any subsequent call mutates these buffers.
        let (rows_view, agg_view) = unsafe {
            (
                Float64Array::view(&self.row_buf),
                Float64Array::view(&self.agg_buf),
            )
        };
        let obj = Object::new();
        js_set(&obj, "count", count as f64);
        js_set(&obj, "rows", rows_view);
        js_set(&obj, "aggregated", agg_view);
        js_set(&obj, "specLen", self.spec_len as f64);
        obj.into()
    }
}

/// An empty result object for the not-loaded / no-feature cases.
fn empty_result(spec_len: usize) -> JsValue {
    let obj = Object::new();
    js_set(&obj, "count", 0.0_f64);
    js_set(&obj, "rows", Float64Array::new(&0.into()));
    js_set(&obj, "aggregated", Float64Array::new(&0.into()));
    js_set(&obj, "specLen", spec_len as f64);
    obj.into()
}

/// An empty hybrid result for the not-loaded / no-feature cases of
/// `get_clusters_ids`.
fn empty_ids_result(spec_len: usize) -> JsValue {
    let obj = Object::new();
    js_set(&obj, "point_ids", Uint32Array::new(&0.into()));
    js_set(&obj, "cluster_rows", Float64Array::new(&0.into()));
    js_set(&obj, "cluster_aggregated", Float64Array::new(&0.into()));
    js_set(&obj, "count", 0.0_f64);
    js_set(&obj, "specLen", spec_len as f64);
    obj.into()
}

/// Set a key on a JS object from any `Into<JsValue>`.
fn js_set(obj: &Object, key: &str, val: impl Into<JsValue>) {
    let _ = Reflect::set(obj, &key.into(), &val.into());
}

/// Extract the features array from a FeatureCollection or plain array.
/// Returns a `Vec<JsValue>` of feature objects.
fn parse_features(geojson: &JsValue) -> Result<Vec<JsValue>, JsValue> {
    if geojson.is_null() || geojson.is_undefined() {
        return Ok(Vec::new());
    }
    if let Some(obj) = geojson.dyn_ref::<Object>() {
        // FeatureCollection: read the "features" property.
        if let Ok(features_val) = Reflect::get(obj, &"features".into()) {
            if let Some(arr) = features_val.dyn_ref::<Array>() {
                return Ok(arr.to_vec());
            }
        }
    }
    // Plain array of features.
    if let Some(arr) = geojson.dyn_ref::<Array>() {
        return Ok(arr.to_vec());
    }
    Err(JsValue::from_str("load: geojson must be a FeatureCollection or an array of features"))
}

/// Parse a JS options object into Rust `Options` + the spec length. Absent
/// keys take supercluster's defaults.
fn parse_options(options: &JsValue) -> Result<(Options, usize), JsValue> {
    let mut opts = Options::default();
    let mut spec_len = 0usize;
    if options.is_null() || options.is_undefined() {
        return Ok((opts, spec_len));
    }
    let obj = options
        .dyn_ref::<Object>()
        .ok_or_else(|| JsValue::from_str("load: options must be an object"))?;

    if let Some(v) = get_f64(obj, "minZoom") {
        opts.min_zoom = v as i32;
    }
    if let Some(v) = get_f64(obj, "maxZoom") {
        opts.max_zoom = v as i32;
    }
    if let Some(v) = get_f64(obj, "minPoints") {
        opts.min_points = v as u32;
    }
    if let Some(v) = get_f64(obj, "radius") {
        opts.radius = v;
    }
    if let Some(v) = get_f64(obj, "extent") {
        opts.extent = v;
    }
    if let Some(v) = get_f64(obj, "nodeSize") {
        opts.node_size = v as u32;
    }

    // Aggregation spec: { fields: [{name, prop, op}, ...] }.
    if let Ok(agg_val) = Reflect::get(obj, &"aggregation".into()) {
        if let Some(agg_obj) = agg_val.dyn_ref::<Object>() {
            if let Ok(fields_val) = Reflect::get(agg_obj, &"fields".into()) {
                if let Some(fields_arr) = fields_val.dyn_ref::<Array>() {
                    let mut spec = AggregationSpec::new();
                    for f in fields_arr.to_vec() {
                        let f_obj = f
                            .dyn_ref::<Object>()
                            .ok_or_else(|| JsValue::from_str("load: aggregation field must be an object"))?;
                        let name = get_string(f_obj, "name")
                            .ok_or_else(|| JsValue::from_str("load: aggregation field missing 'name'"))?;
                        let prop = get_string(f_obj, "prop")
                            .ok_or_else(|| JsValue::from_str("load: aggregation field missing 'prop'"))?;
                        let op_str = get_string(f_obj, "op")
                            .ok_or_else(|| JsValue::from_str("load: aggregation field missing 'op'"))?;
                        let op = parse_op(&op_str)
                            .ok_or_else(|| JsValue::from_str("load: aggregation op must be sum/count/min/max/mean"))?;
                        // AggField.name/.prop are &'static str; the boundary
                        // leaks the JS strings to 'static (bounded: a few fields,
                        // once per load, long worker lifetime — see plan R3).
                        let name_static: &'static str = Box::leak(name.into_boxed_str());
                        let prop_static: &'static str = Box::leak(prop.into_boxed_str());
                        spec = spec.with(name_static, prop_static, op);
                    }
                    spec_len = spec.len();
                    opts.spec = spec;
                }
            }
        }
    }

    Ok((opts, spec_len))
}

/// Build `Vec<PointFeature>` from the JS feature objects, populating
/// `numeric_props` from the spec's named source properties (the ticket-06-
/// deferred boundary work). `properties` is left `None` — the main thread
/// keeps the originals for point rendering; the build loop never reads them.
fn build_point_features(features: &[JsValue], spec: &AggregationSpec) -> Result<Vec<PointFeature>, JsValue> {
    let spec_fields: Vec<(&'static str, &'static str, AggOp)> =
        spec.iter().map(|f| (f.name, f.prop, f.op)).collect();
    let mut points = Vec::with_capacity(features.len());
    // Intern the property-name `JsValue`s once, outside the per-feature loop.
    // `&"geometry".into()` would otherwise allocate a fresh externref-table
    // entry (and copy the string) for *every* feature — at 6M features that
    // is ~24M needless `Reflect::get` key allocations on the load hot path
    // (the measured bottleneck: WASM load is parse-bound, ~1.5 us/feature of
    // FFI overhead, independent of data distribution). Interning drops that
    // to one allocation per key per load.
    let key_geometry = JsValue::from_str("geometry");
    let key_coordinates = JsValue::from_str("coordinates");
    let key_properties = JsValue::from_str("properties");
    for f in features {
        let f_obj = match f.dyn_ref::<Object>() {
            Some(o) => o,
            None => continue, // skip non-object entries
        };
        // coord from geometry.coordinates; None for geometry:null (skipped on load).
        let coord = read_coord(f_obj, &key_geometry, &key_coordinates);
        let mut pf = match coord {
            Some([lng, lat]) => PointFeature::new(lng, lat),
            None => {
                // geometry:null features still pass through to load (which
                // skips them), preserving the full-input count for ADR 0004's
                // id offset base. Carry a placeholder coord-free feature.
                PointFeature {
                    coord: None,
                    properties: None,
                    numeric_props: Vec::new(),
                }
            }
        };
        // numeric_props: read each spec field's source prop off properties.
        if !spec_fields.is_empty() {
            if let Ok(props_val) = Reflect::get(f_obj, &key_properties) {
                if let Some(props_obj) = props_val.dyn_ref::<Object>() {
                    for (_name, prop, _op) in &spec_fields {
                        if let Some(v) = get_f64(props_obj, prop) {
                            // Keyed by the SOURCE property name: the build
                            // loop seeds accumulators via
                            // `get_numeric(spec_field.prop)` (lattice.rs), so
                            // the sidecar must store under `prop`, not the
                            // spec field's output `name`.
                            pf = pf.with_numeric(prop, v);
                        }
                        // missing/non-numeric -> contributes nothing (identity)
                    }
                }
            }
        }
        points.push(pf);
    }
    Ok(points)
}

/// Build `Vec<PointFeature>` directly from a flat `[lng, lat, lng, lat, ...]`
/// coordinate slice — the pure-Rust core of the `load_coords` fast path. No
/// `JsValue`/`Reflect::get` per feature (the GeoJSON parse that dominates
/// `load` is bypassed). `numeric_props` is empty (a flat array carries no
/// properties); `properties` is `None`. The caller has already validated that
/// `flat.len()` is even.
fn build_point_features_from_coords(flat: &[f64]) -> Vec<PointFeature> {
    let mut points = Vec::with_capacity(flat.len() / 2);
    let mut i = 0;
    while i + 1 < flat.len() {
        points.push(PointFeature::new(flat[i], flat[i + 1]));
        i += 2;
    }
    points
}

/// Read `[lng, lat]` from `geometry.coordinates`. `None` if geometry is null
/// or the coordinates are not a 2-element numeric array. The `key_geometry`/
/// `key_coordinates` `JsValue`s are interned by the caller (once per load) and
/// passed in to avoid per-feature key allocation on the load hot path.
fn read_coord(feat: &Object, key_geometry: &JsValue, key_coordinates: &JsValue) -> Option<[f64; 2]> {
    let geom = Reflect::get(feat, key_geometry).ok()?;
    if geom.is_null() || geom.is_undefined() {
        return None;
    }
    let geom_obj = geom.dyn_ref::<Object>()?;
    let coords = Reflect::get(geom_obj, key_coordinates).ok()?;
    let arr = coords.dyn_ref::<Array>()?;
    if arr.length() < 2 {
        return None;
    }
    let lng = arr.get(0).as_f64()?;
    let lat = arr.get(1).as_f64()?;
    Some([lng, lat])
}

fn get_f64(obj: &Object, key: &str) -> Option<f64> {
    Reflect::get(obj, &key.into()).ok().and_then(|v| v.as_f64())
}

fn get_string(obj: &Object, key: &str) -> Option<String> {
    let v = Reflect::get(obj, &key.into()).ok()?;
    v.as_string()
}

fn parse_op(s: &str) -> Option<AggOp> {
    match s {
        OP_SUM => Some(AggOp::Sum),
        OP_COUNT => Some(AggOp::Count),
        OP_MIN => Some(AggOp::Min),
        OP_MAX => Some(AggOp::Max),
        OP_MEAN => Some(AggOp::Mean),
        _ => None,
    }
}
