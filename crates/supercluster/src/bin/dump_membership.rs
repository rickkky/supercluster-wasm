//! On-demand Rust membership dumper (ticket 04, option B of the oracle).
//!
//! Builds the Rust `Supercluster` index over a CLI-specified dataset and emits
//! its per-zoom Cluster membership as JSON, in the same shape
//! `bench/oracle/capture-membership.js` writes for the JS fixtures. The JS
//! cross-diff script (`bench/oracle/oracle-1m-rust.js`) runs JS supercluster
//! over the same `(dataset, n, seed)` triple, invokes this binary, and feeds
//! both memberships to the shared `diffMemberships` — a live, at-scale
//! equivalence check the CI-gated fixture oracle (option A) cannot reach
//! without committing multi-megabyte fixtures.
//!
//! This is NOT a CI gate. It is the on-demand, benchmark-scale counterpart to
//! `bench/oracle/oracle-1m.js` (the JS-vs-JS scale check). Run it via the JS
//! driver: `pnpm oracle:1m-rust` (or `SIZES=6000000 pnpm oracle:1m-rust`).
//!
//! Enabled via the `fixture` cargo feature (which pulls in `serde_json`); the
//! release library stays serde-free. The dataset generators live in
//! `supercluster::datasets`, behind the same feature gate.
//!
//! # Usage
//! ```text
//! dump-membership <ROOT> <DATASET> <N> <SEED>
//!   ROOT     repo root path (so fixtures resolve regardless of CWD)
//!   DATASET  places | uniform | clustered
//!   N        point count (ignored for `places`)
//!   SEED     PRNG seed (ignored for `places`)
//! ```
//! Emits one JSON fixture document on stdout.

use std::io::Write;

use supercluster::datasets::{
    clustered_synthetic, load_centers_at, load_places_at, uniform_random,
};
use supercluster::options::Options;
use supercluster::oracle::MembershipFixture;
use supercluster::supercluster::Supercluster;

/// The oracle's zoom range and options — must mirror `bench/oracle/config.js`
/// exactly, or the cross-diff compares across mismatched zooms. `ALL_ZOOMS` =
/// `[0,1,2,3,4,5,6]`; `maxZoom = 6` (the benchmark configuration).
const ALL_ZOOMS: [i32; 7] = [0, 1, 2, 3, 4, 5, 6];

fn oracle_options() -> Options {
    Options {
        max_zoom: 6,
        ..Options::default()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!(
            "usage: {} <ROOT> <DATASET=places|uniform|clustered> <N> <SEED>",
            args[0]
        );
        std::process::exit(2);
    }
    let root = &args[1];
    let dataset = &args[2];
    let n: usize = args[3].parse().expect("N must be a usize");
    let seed: u32 = args[4].parse().expect("SEED must be a u32");

    // Build the same points the JS driver builds over the same (dataset, n,
    // seed) triple. `datasets` mirrors `bench/datasets/generate.js` byte for
    // byte (pinned by the integration tests), so both sides see identical
    // input — the precondition for a membership diff to mean anything.
    let points = match dataset.as_str() {
        "places" => load_places_at(root),
        "uniform" => uniform_random(n, seed),
        "clustered" => {
            let centers = load_centers_at(root);
            clustered_synthetic(n, seed, &centers)
        }
        other => {
            eprintln!("unknown dataset {other:?}; expected places|uniform|clustered");
            std::process::exit(2);
        }
    };

    let point_count = points.len();
    let geometry_bearing = points.iter().filter(|p| p.coord.is_some()).count();

    let index = Supercluster::load(points, oracle_options());

    // Recover membership per zoom via the same internal parent_id traversal the
    // fixture oracle uses (`extract_membership`), then shape it as a fixture so
    // `to_json` emits the canonical document `diffMemberships` consumes.
    let mut membership = std::collections::HashMap::new();
    for &z in &ALL_ZOOMS {
        membership.insert(z, index.extract_membership(z));
    }
    let fixture = MembershipFixture {
        max_zoom: oracle_options().max_zoom,
        point_count,
        geometry_bearing,
        zooms: ALL_ZOOMS.to_vec(),
        membership,
    };

    // Emit compact JSON on stdout (the driver parses it, so no need for pretty
    // printing; compact keeps multi-megabyte 1M/6M dumps smaller).
    let json = serde_json::to_vec(&fixture.to_json()).expect("membership serializes");
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(&json).expect("write membership JSON");
    lock.write_all(b"\n").ok();
}
