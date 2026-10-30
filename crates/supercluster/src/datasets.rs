//! Seeded dataset generators mirroring `bench/datasets/generate.js` byte for
//! byte, so a Rust-built index can be diffed against the JS oracle for the same
//! `(n, seed)` pair.
//!
//! Gated behind `cfg(any(test, feature = "fixture"))`: the integration tests
//! use it via `cfg(test)`, and the on-demand `dump-membership` binary (option B
//! of ticket 04's oracle) enables the `fixture` feature. The release library
//! has no `serde_json` dependency — these generators serialize point
//! properties to JSON bytes, so they pull in `serde_json`, which is why they
//! live behind the feature gate rather than in the always-compiled surface.
//!
//! The PRNG is xorshift32 (matching `generate.js`'s `createRng`); `Math.random`
//! is deliberately avoided on both sides so datasets are reproducible across
//! machines and Node/Rust versions.

#![cfg(any(test, feature = "fixture"))]

use crate::feature::PointFeature;

/// Seeded xorshift32 PRNG — the same one `bench/datasets/generate.js` uses.
struct Rng {
    state: u32,
}
impl Rng {
    fn new(seed: u32) -> Self {
        // xorshift32 cannot start at 0; remap, matching generate.js.
        let state = if seed == 0 { 0x9e3779b9 } else { seed };
        Self { state }
    }
    fn next_f64(&mut self) -> f64 {
        let mut s = self.state;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.state = s;
        // generate.js returns state / 0x100000000 (a float in [0,1)). state is
        // a u32 promoted to a JS number, so divide by 2^32 exactly.
        f64::from(s) / 4_294_967_296.0
    }
}

/// Generate `n` uniform-random GeoJSON Point features, matching
/// `bench/datasets/generate.js`'s `uniformRandom(n, seed)` byte-for-byte:
/// lng in [-180, 180), lat in [-80, 80), each carrying `properties.index = i`.
#[must_use]
pub fn uniform_random(n: usize, seed: u32) -> Vec<PointFeature> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let lng = -180.0 + 360.0 * rng.next_f64();
        let lat = -80.0 + 160.0 * rng.next_f64();
        let mut props = serde_json::Map::new();
        props.insert("index".to_string(), serde_json::Value::from(i as i64));
        out.push(PointFeature {
            coord: Some([lng, lat]),
            properties: Some(serde_json::to_vec(&serde_json::Value::Object(props)).unwrap()),
            numeric_props: Vec::new(),
        });
    }
    out
}

/// Standard normal via Box-Muller, driven by `rng`. Matches
/// `bench/datasets/generate.js`'s `gaussian`: rejection on `u==0`/`v==0`,
/// then `sqrt(-2 ln u) * cos(2π v)`.
fn gaussian(rng: &mut Rng) -> f64 {
    let mut u = 0.0;
    let mut v = 0.0;
    while u == 0.0 {
        u = rng.next_f64();
    }
    while v == 0.0 {
        v = rng.next_f64();
    }
    (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
}

/// Population weight for a center: `11 - scalerank` (inverse prominence proxy),
/// matching `bench/datasets/generate.js`'s `populationWeight`. Missing
/// scalerank defaults to 5.
fn population_weight(scalerank: Option<i64>) -> i64 {
    11 - scalerank.unwrap_or(5)
}

/// A sampling center: its `[lng, lat]` and optional `scalerank` (the population
/// proxy for `clustered_synthetic`).
pub struct Center {
    /// `[longitude, latitude]`.
    pub coord: [f64; 2],
    /// Natural Earth `scalerank` (1 = largest, 10 = smallest); `None` defaults
    /// to a mid-range weight.
    pub scalerank: Option<i64>,
}

/// Load the vendored `centers.json` fixture (162 coordinate-bearing features
/// of `places.json`, the "Null Island" sentinel dropped) as the sampling-
/// center corpus for `clustered_synthetic`. Matches `loadCenters()`.
///
/// `root` is the repo root path (the binary passes it explicitly; tests pass
/// a path relative to their CWD).
#[must_use]
pub fn load_centers_at(root: &str) -> Vec<Center> {
    let path = format!("{root}/bench/fixtures/centers.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("centers.json fixture at {path} must be present: {e}"));
    let collection: serde_json::Value =
        serde_json::from_str(&raw).expect("centers.json is valid JSON");
    let features = collection
        .get("features")
        .and_then(|f| f.as_array())
        .expect("centers.json has a features array");
    features
        .iter()
        .filter_map(|f| {
            let c = f.get("geometry")?.get("coordinates")?.as_array()?;
            let lng = c.first().and_then(|v| v.as_f64())?;
            let lat = c.get(1).and_then(|v| v.as_f64())?;
            let scalerank = f
                .get("properties")
                .and_then(|p| p.get("scalerank"))
                .and_then(|s| s.as_i64());
            Some(Center {
                coord: [lng, lat],
                scalerank,
            })
        })
        .collect()
}

/// Generate `n` clustered-synthetic GeoJSON Point features, matching
/// `bench/datasets/generate.js`'s `clusteredSynthetic(n, seed, centers)`: a
/// center is drawn population-weighted (scalerank as the population proxy),
/// then a Gaussian offset is added in degrees (LNG_SPREAD 1.5, LAT_SPREAD 1.0).
#[must_use]
pub fn clustered_synthetic(n: usize, seed: u32, centers: &[Center]) -> Vec<PointFeature> {
    assert!(
        !centers.is_empty(),
        "need at least one center with geometry"
    );

    let mut rng = Rng::new(seed);

    // Cumulative distribution over centers for population-weighted sampling.
    let total_weight: i64 = centers.iter().map(|c| population_weight(c.scalerank)).sum();
    let total_weight = total_weight as f64;
    let mut cumulative = vec![0.0f64; centers.len()];
    let mut acc = 0.0;
    for (i, c) in centers.iter().enumerate() {
        acc += population_weight(c.scalerank) as f64 / total_weight;
        cumulative[i] = acc;
    }
    // Guard against fp drift, matching generate.js.
    if let Some(last) = cumulative.last_mut() {
        *last = 1.0;
    }

    let lng_spread = 1.5;
    let lat_spread = 1.0;

    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let r = rng.next_f64();
        // Binary search for the first cumulative entry >= r.
        let mut lo = 0usize;
        let mut hi = centers.len() - 1;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if cumulative[mid] < r {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let [lng, lat] = centers[lo].coord;
        let gl = gaussian(&mut rng) * lng_spread;
        let ga = gaussian(&mut rng) * lat_spread;
        let mut props = serde_json::Map::new();
        props.insert("index".to_string(), serde_json::Value::from(i as i64));
        out.push(PointFeature {
            coord: Some([lng + gl, lat + ga]),
            properties: Some(serde_json::to_vec(&serde_json::Value::Object(props)).unwrap()),
            numeric_props: Vec::new(),
        });
    }
    out
}

/// Load the vendored `places.json` fixture (163 real geographic Points) as
/// `PointFeature`s, including the "Null Island" feature with `geometry: null`
/// (represented here as an empty `coord`, which `load` skips).
///
/// `root` is the repo root path.
#[must_use]
pub fn load_places_at(root: &str) -> Vec<PointFeature> {
    let path = format!("{root}/bench/fixtures/places.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("places.json fixture at {path} must be present: {e}"));
    let collection: serde_json::Value =
        serde_json::from_str(&raw).expect("places.json is valid JSON");
    let features = collection
        .get("features")
        .and_then(|f| f.as_array())
        .expect("places.json has a features array");
    features
        .iter()
        .map(|f| {
            let geom = f.get("geometry");
            let coord = geom
                .and_then(|g| g.get("coordinates"))
                .and_then(|c| c.as_array())
                .and_then(|c| {
                    let lng = c.first().and_then(|v| v.as_f64())?;
                    let lat = c.get(1).and_then(|v| v.as_f64())?;
                    Some([lng, lat])
                }); // geometry: null -> None, skipped on load
            let props = f.get("properties").map(|p| serde_json::to_vec(p).unwrap());
            // Pre-extract `scalerank` (the property ticket 06's test case
            // aggregates) into the numeric sidecar, so the build loop can fold
            // it with no JSON parsing. The WASM boundary (ticket 07) will do
            // this generically for any named spec property; here we extract
            // the one property the fixtures carry that aggregation targets.
            let numeric_props = f
                .get("properties")
                .and_then(|p| p.get("scalerank"))
                .and_then(|s| s.as_f64())
                .map(|v| vec![("scalerank".to_string(), v)])
                .unwrap_or_default();
            PointFeature {
                coord,
                properties: props,
                numeric_props,
            }
        })
        .collect()
}
