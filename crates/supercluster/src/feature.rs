//! Input Point type: a GeoJSON Point feature, minus the JSON.
//!
//! The query half (ticket 04) and the WASM boundary (ticket 07) own the
//! GeoJSON↔Rust conversion; the build loop consumes plain Rust structs so
//! it can be unit-tested without a JSON dependency in the hot path.
//! A `PointFeature` carries the lng/lat coordinate, an opaque `properties`
//! payload (raw JSON bytes, or `None` for a null-property feature), and a
//! `numeric_props` sidecar of pre-extracted `(name, value)` pairs for
//! declarative aggregation (ticket 06). The build loop reads `numeric_props`
//! to seed aggregation accumulators; it never parses `properties`.
//!
//! Features with `geometry: null` are skipped on load, matching supercluster's
//! `if (!p.geometry) continue` — the "Null Island" sentinel in `places.json`
//! is the motivating case. This is the only place the input shape diverges from
//! "every entry is a point."

/// A GeoJSON Point feature, as plain Rust.
///
/// `coord.0` is longitude, `coord.1` is latitude (GeoJSON's `[lng, lat]` order).
/// `properties` is opaque to this crate's build loop; it is carried through so
/// the query half and the WASM boundary can read it later. It is the raw JSON
/// bytes of the feature's `properties` (`None` for a `null` property), so the
/// library has no JSON dependency and the WASM boundary can pass bytes through
/// cheaply.
///
/// `numeric_props` is the aggregation sidecar (ticket 06): the numeric values
/// a declarative [`AggregationSpec`](crate::aggregation::AggregationSpec)
/// names, pre-extracted at the WASM boundary (where GeoJSON is already being
/// parsed) so the build loop folds them with **zero JSON parsing on the hot
/// path**. The build loop looks up a value by property name here; a missing
/// property contributes nothing (the accumulator stays at its identity). This
/// preserves the deliberate serde-free release library: `serde_json` stays
/// gated behind the `fixture` feature, and the boundary owns the one-time
/// parse that populates this field.
#[derive(Debug, Clone)]
pub struct PointFeature {
    /// `[longitude, latitude]` in degrees, or `None` for a `geometry: null`
    /// feature (which `load` skips, matching supercluster's
    /// `if (!p.geometry) continue`).
    pub coord: Option<[f64; 2]>,
    /// Opaque properties payload: raw JSON bytes, or `None` for null
    /// properties. The build loop does not inspect this.
    pub properties: Option<Vec<u8>>,
    /// Pre-extracted numeric properties for aggregation (ticket 06). Each
    /// entry is `(name, value)`; the build loop seeds an accumulator per spec
    /// field by looking up `name` here. Empty for features with no numeric
    /// properties (the common case for the generated datasets, which carry
    /// only `index`). The WASM boundary (ticket 07) populates this while
    /// parsing GeoJSON; tests populate it directly.
    pub numeric_props: Vec<(String, f64)>,
}

impl PointFeature {
    /// Construct a feature with null properties and no numeric props.
    #[must_use]
    pub fn new(lng: f64, lat: f64) -> Self {
        Self {
            coord: Some([lng, lat]),
            properties: None,
            numeric_props: Vec::new(),
        }
    }

    /// Read the numeric value of a named property, if present. Returns `None`
    /// for a missing property — the build loop treats this as "contributes
    /// nothing" (the accumulator stays at its identity), matching JS
    /// supercluster's `map: props => ({sum: props.scalerank})` reading
    /// `undefined` as `NaN`/skipped. Linear scan; the property count per
    /// feature is small (typically 1–3 named aggregables).
    #[must_use]
    pub fn get_numeric(&self, name: &str) -> Option<f64> {
        self.numeric_props.iter().find(|(n, _)| n == name).map(|(_, v)| *v)
    }

    /// Builder-style setter for a numeric property, for test/fixture
    /// construction. Returns `self` for chaining.
    #[must_use]
    pub fn with_numeric(mut self, name: &str, value: f64) -> Self {
        self.numeric_props.push((name.to_string(), value));
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_sets_coord_and_null_properties() {
        let f = PointFeature::new(-79.04, 43.08);
        assert_eq!(f.coord, Some([-79.04, 43.08]));
        assert!(f.properties.is_none());
        assert!(f.numeric_props.is_empty());
    }

    #[test]
    fn get_numeric_finds_present_property() {
        let f = PointFeature::new(0.0, 0.0)
            .with_numeric("scalerank", 2.0)
            .with_numeric("population", 1000.0);
        assert_eq!(f.get_numeric("scalerank"), Some(2.0));
        assert_eq!(f.get_numeric("population"), Some(1000.0));
    }

    #[test]
    fn get_numeric_returns_none_for_missing() {
        let f = PointFeature::new(0.0, 0.0).with_numeric("scalerank", 2.0);
        assert_eq!(f.get_numeric("absent"), None);
    }
}
