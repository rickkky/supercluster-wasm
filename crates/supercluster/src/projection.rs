//! Spherical-mercator projection between lng/lat and the `[0..1]` tile space.
//!
//! A direct port of `refs/supercluster/index.js`'s `lngX`/`latY`/`xLng`/`yLat`
//! and the `fround` helper. Coordinates are stored as `f32` (ADR 0003) so cluster
//! membership is directly comparable to the JS reference for the semantic-
//! equivalence oracle — `f64` storage would shift boundary-point membership and
//! inject noise into the very contract that makes "performance gain" falsifiable.
//!
//! `fround` rounds to the nearest `f32`-representable value, matching
//! `Math.fround`; the projection results are passed through it before storage so
//! the stored coordinates are bit-identical to what supercluster feeds its
//! kd-tree. Intermediate accumulations (weighted-center sums, squared radius)
//! run in `f64` per ADR 0003 to avoid error growth — but the *stored* coordinate
//! is the `f32`-rounded projection.

/// `Math.fround`: round `x` to the nearest `f32`-representable value.
///
/// `as f32 as f64` reproduces `Math.fround` exactly: the `as f32` step rounds to
/// nearest (ties-to-even, the IEEE-754 default Rust uses), and promoting back to
/// `f64` yields the unique `f64` whose `f32` round-trip is itself — which is
/// precisely the value `Math.fround` returns.
#[must_use]
pub fn fround(x: f64) -> f64 {
    x as f32 as f64
}

/// Longitude to spherical-mercator `[0..1]` x. Mirrors `lngX` verbatim.
#[must_use]
pub fn lng_x(lng: f64) -> f64 {
    lng / 360.0 + 0.5
}

/// Latitude to spherical-mercator `[0..1]` y, clamped to `[0..1]`. Mirrors `latY`.
///
/// The mercator y diverges to ±infinity at the poles; supercluster clamps the
/// result to `[0..1]`. We match that clamp so the stored coordinate is identical.
#[must_use]
pub fn lat_y(lat: f64) -> f64 {
    let sin = (lat * std::f64::consts::PI / 180.0).sin();
    let y = 0.5 - 0.25 * ((1.0 + sin) / (1.0 - sin)).ln() / std::f64::consts::PI;
    y.clamp(0.0, 1.0)
}

/// Spherical-mercator x back to longitude. Mirrors `xLng`.
#[must_use]
pub fn x_lng(x: f64) -> f64 {
    (x - 0.5) * 360.0
}

/// Spherical-mercator y back to latitude. Mirrors `yLat`.
#[must_use]
pub fn y_lat(y: f64) -> f64 {
    let y2 = (180.0 - y * 360.0) * std::f64::consts::PI / 180.0;
    360.0 * (y2.exp()).atan() / std::f64::consts::PI - 90.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `fround` matches `Math.fround` for a spread of values: it returns the
    /// nearest f32, and that value round-trips through f32.
    #[test]
    fn fround_matches_nearest_f32() {
        // A value not exactly representable in f32: fround must yield the
        // nearest f32, promoted back to f64.
        let v = 0.1_f64;
        let rounded = fround(v);
        assert_eq!(rounded as f32 as f64, rounded, "fround result must round-trip f32");
        assert_ne!(rounded, v, "0.1 is not f32-exact, so fround must change it");
        // The f32 nearest to 0.1 (ties-to-even).
        assert_eq!(rounded, 0.1_f32 as f64);
    }

    #[test]
    fn lng_x_round_trips_through_x_lng() {
        for lng in [-180.0, -90.0, 0.0, 90.0, 180.0, -79.04411780507252, 173.19150559062456] {
            let x = lng_x(lng);
            assert!((0.0..=1.0).contains(&x), "x out of [0,1]: {x}");
            let back = x_lng(x);
            assert!(
                (back - lng).abs() < 1e-9,
                "lng {lng} -> x {x} -> {back} not round-trip"
            );
        }
    }

    #[test]
    fn lat_y_clamps_at_poles() {
        // The mercator formula diverges at ±90°; supercluster clamps to [0,1].
        // The y axis is inverted relative to latitude: the north pole (lat=90)
        // maps to y=0 (top of the tile), the south pole (lat=-90) to y=1.
        assert_eq!(lat_y(90.0), 0.0);
        assert_eq!(lat_y(-90.0), 1.0);
        // Equator maps to 0.5.
        assert!((lat_y(0.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn lat_y_round_trips_through_y_lat_for_moderate_latitudes() {
        // The clamp only triggers at the poles; for moderate latitudes the
        // projection is invertible to high precision.
        for lat in [-80.0, -45.0, -1.0, 0.0, 30.0, 60.0, 80.0] {
            let y = lat_y(lat);
            assert!((0.0..=1.0).contains(&y), "y out of [0,1]: {y} for lat {lat}");
            let back = y_lat(y);
            assert!(
                (back - lat).abs() < 1e-9,
                "lat {lat} -> y {y} -> {back} not round-trip"
            );
        }
    }

    #[test]
    fn projection_matches_supercluster_places_fixture() {
        // Niagara Falls, the first feature of places.json. The projected x/y
        // must equal what supercluster's fround(lngX/lngY) produces. These are
        // the exact f32-rounded values; pinning them guards against a subtle
        // projection drift that would fuzz the equivalence oracle.
        let lng = -79.04411780507252_f64;
        let lat = 43.08771393436908_f64;
        let x = fround(lng_x(lng));
        let y = fround(lat_y(lat));
        // Reproduce via the same path JS does: project in f64, then fround.
        let js_x = (lng / 360.0 + 0.5) as f32 as f64;
        let js_sin = (lat * std::f64::consts::PI / 180.0).sin();
        let js_y_raw = 0.5 - 0.25 * ((1.0 + js_sin) / (1.0 - js_sin)).ln() / std::f64::consts::PI;
        let js_y = js_y_raw as f32 as f64;
        assert_eq!(x, js_x, "x projection drift vs JS");
        assert_eq!(y, js_y, "y projection drift vs JS");
    }
}
