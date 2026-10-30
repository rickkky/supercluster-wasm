//! Shared test helpers: load `places.json` and generate the seeded datasets
//! the JS oracle uses, so Rust-side tests can build the same inputs.
//!
//! The PRNG mirrors `bench/datasets/generate.js`'s xorshift32 exactly so a
//! Rust-built lattice can be diffed against the JS oracle's expected
//! membership for the *same* (n, seed) pair. `Math.random` is deliberately
//! avoided on both sides.
//!
//! `allow(dead_code)`: this module is compiled once per test target, so each
//! test file sees the helpers it does not call as dead code. Every helper here
//! is used by at least one test target; the warnings are an artifact of
//! per-target compilation, not genuine dead code.
//!
//! DUPLICATION NOTE: these generator bodies are mirrored near-verbatim in
//! `crates/supercluster/src/datasets.rs` (the `fixture`-feature-gated copy the
//! `dump-membership` binary uses). The split is deliberate: `datasets.rs` is
//! `cfg(any(test, feature = "fixture"))`, and the integration tests cannot
//! enable `fixture` without pulling `serde_json` into the test build, so the
//! test target keeps its own serde-free copy. `datasets.rs` is the canonical
//! copy (it is cross-checked against JS at 1M scale by the on-demand oracle);
//! if `generate.js` changes, update both — they must stay byte-for-byte
//! identical to keep the oracle's same-input precondition.

#![allow(dead_code)]

use supercluster::feature::PointFeature;
use supercluster::options::Options;
use supercluster::oracle::MembershipFixture;

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

/// Load the vendored `centers.json` fixture (162 coordinate-bearing features
/// of `places.json`, the "Null Island" sentinel dropped) as the sampling-
/// center corpus for `clustered_synthetic`. Matches `loadCenters()`.
pub fn load_centers() -> Vec<([f64; 2], Option<i64>)> {
    let raw = std::fs::read_to_string("../../bench/fixtures/centers.json")
        .or_else(|_| std::fs::read_to_string("bench/fixtures/centers.json"))
        .expect("centers.json fixture must be present");
    let collection: serde_json::Value = serde_json::from_str(&raw).expect("centers.json is valid JSON");
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
            Some(([lng, lat], scalerank))
        })
        .collect()
}

/// Generate `n` clustered-synthetic GeoJSON Point features, matching
/// `bench/datasets/generate.js`'s `clusteredSynthetic(n, seed, centers)`: a
/// center is drawn population-weighted (scalerank as the population proxy),
/// then a Gaussian offset is added in degrees (LNG_SPREAD 1.5, LAT_SPREAD 1.0).
pub fn clustered_synthetic(n: usize, seed: u32) -> Vec<PointFeature> {
    // centers.json is derived from places.json with the Null Island sentinel
    // dropped; load it as the sampling corpus. If absent (e.g. running outside
    // the repo), fall back to places.json's geometry-bearing features.
    let centers = load_centers();
    assert!(!centers.is_empty(), "need at least one center with geometry");

    let mut rng = Rng::new(seed);

    // Cumulative distribution over centers for population-weighted sampling.
    let total_weight: i64 = centers.iter().map(|(_, s)| population_weight(*s)).sum();
    let total_weight = total_weight as f64;
    let mut cumulative = vec![0.0f64; centers.len()];
    let mut acc = 0.0;
    for (i, (_, s)) in centers.iter().enumerate() {
        acc += population_weight(*s) as f64 / total_weight;
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
        let [lng, lat] = centers[lo].0;
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
pub fn load_places() -> Vec<PointFeature> {
    let raw = std::fs::read_to_string("../../bench/fixtures/places.json")
        .or_else(|_| std::fs::read_to_string("bench/fixtures/places.json"))
        .expect("places.json fixture must be present");
    let collection: serde_json::Value = serde_json::from_str(&raw).expect("places.json is valid JSON");
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
            // Pre-extract `scalerank` into the numeric sidecar (mirrors
            // `datasets.rs::load_places_at`), so the build loop can fold it
            // for the ticket-06 aggregation test with no JSON parsing.
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

/// The oracle's default options: supercluster defaults with maxZoom 6 (the
/// benchmark configuration from `refs/supercluster/bench.js`, mirrored in
/// `bench/oracle/config.js`'s `DEFAULT_OPTIONS`).
pub fn oracle_options() -> Options {
    Options {
        max_zoom: 6,
        ..Options::default()
    }
}

/// Load a captured JS-supercluster membership fixture
/// (`bench/fixtures/oracle/<corpus>.json`, written by
/// `bench/oracle/capture-membership.js`). Parses the JSON into the
/// [`MembershipFixture`] the Rust oracle diffs against.
///
/// Constructs the fixture via its public fields rather than the gated
/// `from_json` method, so the integration tests need no `fixture` cargo
/// feature (the lib stays serde-free in release; only this dev helper and the
/// `dump-membership` binary depend on `serde_json`).
pub fn load_membership_fixture(corpus: &str) -> MembershipFixture {
    use std::collections::HashMap;

    // The integration tests run with CWD = crates/supercluster, so the
    // repo-rooted fixture path needs the same `../../` fallback as
    // `load_places`/`load_centers`.
    let path = format!("bench/fixtures/oracle/{corpus}.json");
    let raw = std::fs::read_to_string(&path)
        .or_else(|_| std::fs::read_to_string(format!("../../bench/fixtures/oracle/{corpus}.json")))
        .unwrap_or_else(|e| panic!("membership fixture {path} must be present: {e}"));
    let value: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {path} is valid JSON: {e}"));

    let max_zoom = value
        .get("options")
        .and_then(|o| o.get("maxZoom"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(6);
    let point_count = value
        .get("pointCount")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(0);
    let geometry_bearing = value
        .get("geometryBearing")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(0);
    let zooms: Vec<i32> = value
        .get("zooms")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_i64())
                .map(|v| v as i32)
                .collect()
        })
        .unwrap_or_default();
    let mut membership: HashMap<i32, Vec<Vec<u32>>> = HashMap::new();
    if let Some(obj) = value.get("membership").and_then(|v| v.as_object()) {
        for (key, val) in obj {
            let z: i32 = key.parse().unwrap_or(-1);
            let arr: Vec<Vec<u32>> = val
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|entry| {
                            entry
                                .as_array()
                                .map(|ids| {
                                    ids.iter()
                                        .filter_map(|v| v.as_u64())
                                        .map(|v| v as u32)
                                        .collect()
                                })
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            membership.insert(z, arr);
        }
    }
    MembershipFixture {
        max_zoom,
        point_count,
        geometry_bearing,
        zooms,
        membership,
    }
}
