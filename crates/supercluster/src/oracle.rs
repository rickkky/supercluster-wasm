//! The Rust half of the semantic-equivalence oracle (ticket 04).
//!
//! A direct port of `bench/oracle/oracle.js`'s `diffMemberships`: a multiset
//! comparison of Cluster memberships per Zoom Level. Two implementations agree
//! at a zoom iff the multiset of memberships (each a sorted source-id array) is
//! identical — every membership in A has an equal membership in B and vice
//! versa.
//!
//! The JS side (`bench/oracle/`) captures JS supercluster's membership into
//! JSON fixtures (`bench/fixtures/oracle/<corpus>.json`); the test helper in
//! `tests/common/mod.rs` loads those fixtures into [`MembershipFixture`], and
//! [`Supercluster::diff_membership_vs_fixture`] diffs the Rust `get_clusters`
//! membership against them. This is the fixture-pinned oracle (option A):
//! CI-gatable, no wasm/FFI.
//!
//! For the on-demand 1M/6M cross-diff (option B), the `dump-membership` binary
//! (see `src/bin/dump_membership.rs`) emits Rust's membership multisets as JSON
//! in the same shape, and a JS script reuses the JS `diffMemberships` for the
//! live cross-diff.
//!
//! This module is serde-free: the diff machinery takes plain Rust types. JSON
//! parsing lives in the test helper and the dump binary (both already depend on
//! `serde_json`), so the release library gains no JSON dependency.

use std::collections::HashMap;

use crate::supercluster::Supercluster;

/// A captured JS-supercluster membership fixture, mirroring the JSON shape
/// `bench/oracle/capture-membership.js` writes. Constructed by the test helper
/// (`tests/common/mod.rs::load_membership_fixture`) or the dump binary from
/// parsed JSON.
#[derive(Debug, Clone)]
pub struct MembershipFixture {
    /// The options the fixture was captured with (only `maxZoom` is used).
    pub max_zoom: i32,
    /// Total source-feature count (including any `geometry: null` features).
    pub point_count: usize,
    /// Geometry-bearing count (the source-id space; `null`-geometry features
    /// are dropped on load and never get a source id).
    pub geometry_bearing: usize,
    /// The zooms the fixture covers.
    pub zooms: Vec<i32>,
    /// Per-zoom membership: one sorted source-id array per top-level entry.
    /// Keyed by zoom (the fixture JSON keys are strings; parsed to i32 by the
    /// loader).
    pub membership: HashMap<i32, Vec<Vec<u32>>>,
}

/// The result of diffing two memberships across a set of zooms.
#[derive(Debug, Clone, Default)]
pub struct MembershipDiff {
    /// One entry per zoom where the multisets differ.
    pub differences: Vec<ZoomDifference>,
    /// Total count of memberships present in only one side (sum of
    /// `only_a`/`only_b` lengths across all differing zooms).
    pub total_differences: usize,
}

/// A per-zoom multiset difference.
#[derive(Debug, Clone)]
pub struct ZoomDifference {
    /// The zoom level.
    pub zoom: i32,
    /// Memberships present only in side A (Rust), each with the excess count.
    pub only_a: Vec<MembershipExcess>,
    /// Memberships present only in side B (fixture), each with the excess count.
    pub only_b: Vec<MembershipExcess>,
}

/// A membership that appears more times on one side than the other, with the
/// count excess.
#[derive(Debug, Clone)]
pub struct MembershipExcess {
    /// The membership (sorted source-id array).
    pub membership: Vec<u32>,
    /// How many more times it appears on this side than the other.
    pub count: usize,
}

impl Supercluster {
    /// Diff Rust's `get_clusters` membership against a captured JS fixture
    /// across the fixture's zooms.
    ///
    /// Returns the multiset difference (zero `total_differences` = exact
    /// membership equivalence at every zoom). This is the fixture-pinned
    /// oracle's core assertion: `diff.total_differences == 0`.
    pub fn diff_membership_vs_fixture(&self, fixture: &MembershipFixture) -> MembershipDiff {
        let mut differences = Vec::new();
        let mut total = 0;
        for &z in &fixture.zooms {
            let rust = self.extract_membership(z);
            let js = fixture.membership.get(&z).cloned().unwrap_or_default();
            let (only_a, only_b) = multiset_diff(&rust, &js);
            if !only_a.is_empty() || !only_b.is_empty() {
                total += only_a.len() + only_b.len();
                differences.push(ZoomDifference {
                    zoom: z,
                    only_a,
                    only_b,
                });
            }
        }
        MembershipDiff {
            differences,
            total_differences: total,
        }
    }
}

/// Canonical multiset key for a membership: the sorted source ids joined by a
/// separator that cannot appear inside an integer. Mirrors the JS
/// `membershipKey`'s `membership.join(',')`.
fn membership_key(membership: &[u32]) -> String {
    // The membership is already sorted+deduped by `extract_membership`; join
    // its decimal ids with ',' (an integer cannot contain a comma, so the key
    // is unambiguous).
    membership
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Multiset difference of two membership lists: memberships present only in `a`
/// or only in `b`, each with the count excess. Mirrors the JS `diffMemberships`'s
/// `keysA`/`keysB` Map comparison.
fn multiset_diff(
    a: &[Vec<u32>],
    b: &[Vec<u32>],
) -> (Vec<MembershipExcess>, Vec<MembershipExcess>) {
    let mut counts_a: HashMap<String, (Vec<u32>, usize)> = HashMap::new();
    for m in a {
        let k = membership_key(m);
        let entry = counts_a.entry(k).or_insert_with(|| (m.clone(), 0));
        entry.1 += 1;
    }
    let mut counts_b: HashMap<String, (Vec<u32>, usize)> = HashMap::new();
    for m in b {
        let k = membership_key(m);
        let entry = counts_b.entry(k).or_insert_with(|| (m.clone(), 0));
        entry.1 += 1;
    }

    let mut only_a = Vec::new();
    for (k, (m, ca)) in &counts_a {
        let cb = counts_b.get(k).map(|(_, c)| *c).unwrap_or(0);
        if *ca > cb {
            only_a.push(MembershipExcess {
                membership: m.clone(),
                count: *ca - cb,
            });
        }
    }
    let mut only_b = Vec::new();
    for (k, (m, cb)) in &counts_b {
        let ca = counts_a.get(k).map(|(_, c)| *c).unwrap_or(0);
        if *cb > ca {
            only_b.push(MembershipExcess {
                membership: m.clone(),
                count: *cb - ca,
            });
        }
    }
    (only_a, only_b)
}

// JSON fixture loading. Gated behind `cfg(test)` (for the integration tests)
// and the `fixture` feature (for the on-demand `dump-membership` binary), so
// the release library has no `serde_json` dependency. Both callers already
// pull in `serde_json` (dev-dependency / the binary's own deps).
#[cfg(any(test, feature = "fixture"))]
impl MembershipFixture {
    /// Load a membership fixture from a pre-parsed JSON value (the shape
    /// `bench/oracle/capture-membership.js` writes).
    pub fn from_json(raw: &serde_json::Value) -> Self {
        let max_zoom = raw
            .get("options")
            .and_then(|o| o.get("maxZoom"))
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .unwrap_or(6);
        let point_count = raw
            .get("pointCount")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(0);
        let geometry_bearing = raw
            .get("geometryBearing")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(0);
        let zooms: Vec<i32> = raw
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
        if let Some(obj) = raw.get("membership").and_then(|v| v.as_object()) {
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

    /// Serialize this fixture (Rust's own membership) to JSON in the same shape
    /// `capture-membership.js` writes, for the on-demand 1M/6M cross-diff.
    /// Used by the `dump-membership` binary.
    pub fn to_json(&self) -> serde_json::Value {
        let mut obj = serde_json::Map::new();
        obj.insert("maxZoom".into(), serde_json::Value::from(self.max_zoom));
        let mut options = serde_json::Map::new();
        options.insert("maxZoom".into(), serde_json::Value::from(self.max_zoom));
        obj.insert("options".into(), serde_json::Value::Object(options));
        obj.insert(
            "pointCount".into(),
            serde_json::Value::from(self.point_count as u64),
        );
        obj.insert(
            "geometryBearing".into(),
            serde_json::Value::from(self.geometry_bearing as u64),
        );
        let zooms: Vec<serde_json::Value> = self
            .zooms
            .iter()
            .map(|&z| serde_json::Value::from(z))
            .collect();
        obj.insert("zooms".into(), serde_json::Value::Array(zooms));
        let mut membership = serde_json::Map::new();
        for &z in &self.zooms {
            let arr: Vec<serde_json::Value> = self
                .membership
                .get(&z)
                .map(|ms| {
                    ms.iter()
                        .map(|m| {
                            let ids: Vec<serde_json::Value> =
                                m.iter().map(|&id| serde_json::Value::from(id)).collect();
                            serde_json::Value::Array(ids)
                        })
                        .collect()
                })
                .unwrap_or_default();
            membership.insert(z.to_string(), serde_json::Value::Array(arr));
        }
        obj.insert("membership".into(), serde_json::Value::Object(membership));
        serde_json::Value::Object(obj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Self-diff is zero — the machinery's proof gate (mirrors the JS
    /// `diffMemberships: self-diff returns zero` test).
    #[test]
    fn multiset_diff_self_is_zero() {
        let m = vec![vec![1, 2, 3], vec![4], vec![5, 6]];
        let (only_a, only_b) = multiset_diff(&m, &m);
        assert!(only_a.is_empty());
        assert!(only_b.is_empty());
    }

    /// A genuine difference surfaces — the anti-tautology guard.
    #[test]
    fn multiset_diff_detects_a_difference() {
        let a = vec![vec![1, 2, 3], vec![4]];
        let b = vec![vec![1, 2, 3], vec![5]];
        let (only_a, only_b) = multiset_diff(&a, &b);
        assert_eq!(only_a.len(), 1, "membership [4] only in a");
        assert_eq!(only_b.len(), 1, "membership [5] only in b");
        assert_eq!(only_a[0].membership, vec![4]);
        assert_eq!(only_b[0].membership, vec![5]);
    }

    /// Duplicate memberships are counted as a multiset (two equal clusters
    /// on one side vs one on the other is a 1-excess, not a no-op).
    #[test]
    fn multiset_diff_counts_duplicates() {
        let a = vec![vec![1, 2], vec![1, 2], vec![3]];
        let b = vec![vec![1, 2], vec![3]];
        let (only_a, only_b) = multiset_diff(&a, &b);
        assert_eq!(only_a.len(), 1, "the extra [1,2] is an excess of 1");
        assert_eq!(only_a[0].count, 1);
        assert!(only_b.is_empty());
    }

    /// `membership_key` is unambiguous: ids joined by ',' cannot collide with
    /// a different id sequence (no integer contains a comma).
    #[test]
    fn membership_key_is_unambiguous() {
        assert_ne!(membership_key(&[1, 23]), membership_key(&[12, 3]));
        assert_eq!(membership_key(&[1, 23]), "1,23");
    }
}
