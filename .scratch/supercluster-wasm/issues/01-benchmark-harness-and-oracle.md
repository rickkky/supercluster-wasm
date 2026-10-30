# 01 — Benchmark harness, JS baseline, and oracle machinery

**What to build:** A JavaScript harness that (a) generates the dual benchmark datasets — uniform-random Points (1M and 6M, lng -180..180 / lat -80..80, matching `refs/supercluster/bench.js`) and clustered-synthetic Points (Natural Earth populated-places city coordinates as sampling centers, Gaussian-sampled Points per city, population-weighted, scaled to 1M/6M); (b) runs JS supercluster against these and prints `load` total time plus `getClusters`/`getChildren`/`getLeaves` query timings as the baseline; and (c) provides oracle machinery that loads two clustering implementations and diffs **Cluster membership per Zoom Level**, returning the differing Point sets. The harness must self-verify: a JS-vs-JS self-diff returns zero differences, proving the machinery before any Rust version exists. Bring in the `places.json` fixture (163 real geographic Points, ISC-licensed) with attribution as the oracle seed corpus. This ticket establishes the falsifiable performance baseline and the correctness oracle that every downstream ticket validates against.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Dual dataset generator produces uniform-random and clustered-synthetic Point sets at 1M and 6M with reproducible (seeded) coordinates and documented ranges
- [x] JS supercluster baseline run prints `load` time and query timings for both datasets
- [x] Oracle machinery loads two implementations and diffs Cluster membership per Zoom Level, reporting differing Point sets
- [x] JS-vs-JS self-diff returns zero differences (machinery proven correct)
- [x] `places.json` fixture imported with ISC attribution retained

## Answer

Implemented in commit `bd2acc9` on `temp` (`feat(bench): benchmark harness, JS baseline, and semantic-equivalence oracle (ticket 01)`). The `bench/` harness generates the dual datasets (uniform-random + clustered-synthetic, seeded xorshift32 PRNG, lng -180..180 / lat -80..80), runs JS supercluster to print `load` + `getClusters`/`getChildren`/`getLeaves` timings as the baseline, and provides oracle machinery that diffs cluster membership per zoom between two implementations. JS-vs-JS self-diff returns zero differences — machinery proven before any Rust version exists. `places.json` (163 real geographic points, ISC) brought in as the oracle seed corpus with attribution retained. Establishes the falsifiable performance baseline and the correctness oracle every downstream ticket validates against.
