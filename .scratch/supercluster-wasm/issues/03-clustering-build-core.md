# 03 — Clustering build core: load, projection, and Cluster Lattice construction

**What to build:** The build half of the clustering stack: `load(Points)` ingests GeoJSON Point features, projects lng/lat to f32 spherical-mercator `[0..1]` space (ADR 0003, matching supercluster's `fround`), stores Points in SoA internal layout (x, y, lastZoom, sourceId, parentId, numPoints as separate arrays per Q19), and runs the per-zoom `_cluster` loop that builds the Cluster Lattice — for each Point at each Zoom Level, a radius query via the kdbush `within` (from 02) finds neighbors, and Points meeting `minPoints` are merged into a Cluster with a weighted center. Option semantics match supercluster verbatim (radius/extent/minPoints/maxZoom/nodeSize defaults and the `r = radius / (extent * 2^zoom)` formula, per Q15) so the equivalence oracle's pruning boundaries align. cluster_ids are internally stable and drillable but need not match supercluster's encoding. This ticket is verified structurally — the Cluster Lattice is built and queryable — but full behavioral verification lands in 04 (the query half), so 03's acceptance is "the lattice builds without panic and the SoA arrays are populated correctly for a known small input."

**Blocked by:** 02 (kdbush Spatial Index port).

**Status:** resolved

- [x] `load(Points)` ingests GeoJSON Point features and projects to f32 spherical-mercator `[0..1]`
- [x] SoA internal layout (x/y/lastZoom/sourceId/parentId/numPoints as separate arrays) is populated
- [x] Per-zoom `_cluster` loop builds a Cluster Lattice using kdbush `within` radius queries
- [x] Option semantics (radius/extent/minPoints/maxZoom/nodeSize defaults and radius formula) match supercluster
- [x] Cluster Lattice builds without panic on `places.json` (163 Points) and a small generated set; SoA arrays populated correctly for a hand-checked input

## Answer

Implemented in commit `fa81bd3` on `temp` (`feat(supercluster): clustering build core — load, projection, Cluster Lattice (ticket 03)`). Build half of the clustering stack is green: `load` + f32 spherical-mercator projection + SoA Cluster Lattice + per-zoom `_cluster` loop, in the new `crates/supercluster/` crate. ADR 0003 amended to record cluster centers are f64 (matching supercluster's `data`/`Float32Array` asymmetry) — required for membership equivalence. Behavioral verification exceeds the ticket's "builds without panic" bar: per-zoom top-level counts match JS supercluster exactly at all 8 zooms `[0..7]` for both `uniformRandom(1000, 42)` and `clusteredSynthetic(1000, 42)` seeded datasets. `cargo clippy --workspace --all-targets` clean; `cargo test --workspace` all pass. Full membership equivalence and the query half (`getClusters`/`getChildren`/`getLeaves`/`getClusterExpansionZoom`) land in tickets 04/05.
