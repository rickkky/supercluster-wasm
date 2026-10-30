# 04 — getClusters query with antimeridian wrapping, oracle-verified

**What to build:** The query half of the clustering core: `getClusters(bbox, zoom)` returns the Clusters and unclustered Points at a given Zoom Level within a bounding box, with antimeridian wrapping (a bbox crossing the international date line splits into eastern/western hemisphere queries whose results concatenate, matching `refs/supercluster/index.js` lines 89–102). Results are returned in a Rust-native form consumable by the later WASM boundary (06). This ticket closes the primary seam in Rust: the semantic-equivalence oracle from 01 now runs against the Rust `load`+`getClusters` and asserts **Cluster membership per Zoom Level matches JS supercluster** on `places.json` and the generated 1M/6M sets. Edge behavior matches supercluster: out-of-range bbox values clamp/wrap rather than reject, non-integer zooms floor to integer (per Q16).

**Blocked by:** 01 (oracle machinery) and 03 (clustering build core).

**Status:** resolved

## Comments

- 2026-08-20 — Claimed. Oracle-bridge approach decided with Ricky: **A+B**
  (fixture-pinned Rust oracle for CI + on-demand CLI membership-dump for the
  live 1M/6M cross-diff). No wasm/FFI in this ticket — the wasm-bindgen
  boundary is ticket 07. Membership is recovered **internally** via `parent_id`
  traversal down the lattice stack (the same hierarchy `getLeaves` will expose
  in 05, but as internal traversal, not the public 05 API — no scope creep).

- 2026-08-20 — Implemented. Option A (fixture-pinned oracle) is CI-gated via
  `tests/oracle.rs` (5 tests): membership matches JS supercluster on
  `places.json`, `uniform-1000-42`, and `clustered-1000-42` (the last exercises
  antimeridian-wrapped points — both sides drop the same lng>180 points from
  the whole-world query, so the membership multiset still matches). Option B
  (on-demand 1M/6M cross-diff) is wired: `dump-membership` binary
  (`crates/supercluster/src/bin/dump_membership.rs`, gated behind the `fixture`
  feature so the release lib stays serde-free) emits Rust's membership as JSON
  in the `capture-membership.js` shape; `bench/oracle/oracle-1m-rust.js` runs
  JS supercluster over the same `(dataset, n, seed)` triple, invokes the
  binary, and feeds both memberships to the shared `diffMemberships`. The
  binary's dataset generators live in a new gated `supercluster::datasets`
  module mirroring `bench/datasets/generate.js` byte-for-byte (pinned by the
  integration tests).

- 2026-08-21 — Perf fix + full 1M/6M verification. The membership-recovery
  path (`extract_membership`/`cluster_leaves`/`append_leaves` in `query.rs`)
  was O(n²): `append_leaves` did a full-lattice scan per cluster to find its
  children. Replaced with a `parent_id -> Vec<child index>` index built once
  per `extract_membership` call (`child_index_for`), turning each child lookup
  into an O(children) map hit. Combined with building the dump binary in
  `--release` (the `oracle:1m-rust` pnpm script now passes `--release`; the
  debug build was ~1000x slower on 1M indexing), the cross-diff is now
  feasible at scale. **Verified zero differences at 1M and 6M** for both
  uniform-random and clustered-synthetic (`pnpm oracle:1m-rust`,
  `SIZES=6000000 pnpm oracle:1m-rust`): at 6M, Rust 10-14s vs JS 37s per
  dataset. Full suite: 52 Rust tests + 30 JS tests pass; `cargo clippy
  --all-targets --features fixture -- -D warnings` clean; release lib verified
  serde-free (`cargo tree -e no-dev,no-build` shows no serde/serde_json with
  default features).

- [x] `getClusters(bbox, zoom)` returns Clusters and unclustered Points within the bbox at the given Zoom Level
- [x] Antimeridian-crossing bbox queries split into eastern/western hemisphere queries and concatenate results
- [x] Out-of-range bbox values clamp/wrap; non-integer zooms floor to integer
- [x] Oracle from 01 confirms Cluster membership per Zoom Level matches JS supercluster on `places.json`
- [x] Oracle confirms membership match on generated 1M and 6M datasets (verified zero-diff at both scales via `pnpm oracle:1m-rust`)

## Answer

Implemented in commit `c8e1738` on `temp` (`feat(supercluster): getClusters query with antimeridian wrapping, oracle-verified (ticket 04)`). Query half of the clustering core lands: `getClusters(bbox, zoom)` with antimeridian wrapping, out-of-range clamp/wrap, and floor-to-int zoom, in `crates/supercluster/src/query.rs`. Oracle approach **A+B** (decided with Ricky): Option A is fixture-pinned `tests/oracle.rs` (5 tests) asserting membership matches JS supercluster on `places.json`, `uniform-1000-42`, and `clustered-1000-42`; Option B is the `dump-membership` binary (gated behind the `fixture` feature) cross-diffed against JS by `bench/oracle/oracle-1m-rust.js`. Perf fix: `extract_membership` went from O(n²) full-lattice scans to O(children) via a `parent_id -> Vec<child index>` map; combined with `--release` builds, **zero differences verified at 1M and 6M** for both uniform-random and clustered-synthetic (Rust 10-14s vs JS 37s at 6M). Suite: 52 Rust + 30 JS tests pass; clippy clean; release lib verified serde-free.
