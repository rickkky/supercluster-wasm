# 05 — Cluster Hierarchy API: getChildren, getLeaves, getClusterExpansionZoom

**What to build:** The drill-down methods that navigate the Cluster Hierarchy across Zoom Levels: `getChildren(clusterId)` returns a Cluster's children on the next Zoom Level; `getLeaves(clusterId, limit, offset)` paginates a Cluster's leaf Points (limit/offset, `limit=Infinity` for all); `getClusterExpansionZoom(clusterId)` returns the Zoom Level at which a Cluster expands into multiple children, including the beyond-maxZoom case (returns maxZoom+1). Verified behaviorally against `refs/supercluster/test/test.js`'s expected outputs — e.g., `getChildren(164)` yields point counts `[6,7,2,1]`, `getClusterExpansionZoom` returns `1/1/2/2/3` for the documented ids and `5` for the beyond-maxZoom case, paginated leaf names match. These are the click-to-expand UX primitives; they must be stable and drillable.

**Blocked by:** 04 (getClusters query, oracle-verified) — needs the queryable Cluster Lattice and the cluster_id scheme.

**Status:** resolved

## Comments

- 2026-08-21 — Claimed. Id-alignment blocker decided with Ricky ("按照你推荐的方案来"):
  align Rust cluster ids to JS by offsetting above the **full input count**
  (`points.len()`, matching JS `this.points.length`) instead of the geometry-bearing
  count, so the literal JS ids `test.js` passes (`164`, `196`, `581`, `1157`, `4134`,
  `2504`, `165`) work as direct arguments with no id-translation layer. This overrides
  spec line 54 ("ids need not match supercluster's encoding"); the override is recorded in
  **ADR 0004**. The 04 membership oracle is id-agnostic (compares source-id multisets),
  so the offset change leaves it green; all existing cluster-id unit tests assert only
  disjointness/monotonicity/round-trip (no numeric id pinned), so they stay green too.

- 2026-08-21 — Implemented. New module `crates/supercluster/src/hierarchy.rs`:
  `get_children` (JS `getChildren`, lines 115–141), `get_cluster_expansion_zoom` (JS
  lines 183–192), `get_leaves` + private `append_leaves_paginated` (JS `getLeaves`/
  `_appendLeaves`, lines 143–151, 194–220), ported verbatim. `get_children` uses the
  `within`+r scan (not 04's `child_index` map) so children come out in kd-tree traversal
  order — `test.js` pins ordered counts `[6, 7, 2, 1]`. `get_leaves` takes
  `Option<usize>` for `limit` (`None` = JS `Infinity`); the pagination semantics thread a
  `skipped` count through the recursion exactly as JS does. Invalid ids return an empty
  `Vec` (no panic) — the crate's no-throw edge style (JS throws "No cluster with the
  specified id.", but `test.js` never probes an invalid id). `tests/hierarchy.rs` (8
  tests) ports the test.js cases. Full suite: 60 Rust tests pass (18 lib + 8 hierarchy +
  7 load_build + 5 options + 5 oracle + 3 places + 2 projection + 12 query);
  `cargo clippy --all-targets --features fixture -- -D warnings` clean.

- [x] `getChildren(clusterId)` returns a Cluster's children on the next Zoom Level
- [x] `getLeaves(clusterId, limit, offset)` paginates leaf Points; `limit=Infinity` returns all
- [x] `getClusterExpansionZoom(clusterId)` returns the expansion Zoom Level, including the beyond-maxZoom case (maxZoom+1)
- [x] Outputs match `test.js` expected values (point counts, expansion zooms, paginated leaves)

## Answer

Implemented in commit `8a1b59d` on `temp` (`feat(supercluster): cluster hierarchy drill-down API (ticket 05)`). The three drill-down methods — `get_children` (JS `getChildren`, lines 115–141), `get_cluster_expansion_zoom` (JS lines 183–192), `get_leaves` + `append_leaves_paginated` (JS `getLeaves`/`_appendLeaves`, lines 143–151, 194–220) — ported verbatim in `crates/supercluster/src/hierarchy.rs`. `get_children` uses the `within`+r scan (kd-tree traversal order, matching `test.js`'s pinned counts `[6,7,2,1]`); `get_leaves` paginates with an `Option<usize>` limit (`None` = JS `Infinity`); invalid ids return empty `Vec` (no-throw edge style). **ADR 0004**: cluster ids aligned to supercluster's encoding — offset base is `points.len()` (JS `this.points.length`), overriding spec line 54, so `test.js`'s literal ids (`164`, `196`, `581`, …) work directly. `tests/hierarchy.rs` ports the 8 `test.js` cases; full suite 60 Rust tests pass; clippy clean.
