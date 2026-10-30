# 02 — Hand-ported kdbush Spatial Index with isolated unit tests

**What to build:** A Rust kdbush module implementing the static kd-tree Spatial Index: Floyd–Rivest bulk-build kd-sort over flat arrays, and iterative-DFS `range` (bbox query) and `within` (radius query) with circle-bbox pruning plus squared-distance post-filter. Zero external spatial-index dependencies; f32 coordinates, mirroring `refs/kdbush/index.js` algorithmically so the semantic-equivalence oracle is straightforward. This ticket also creates the Cargo workspace skeleton the whole library builds on. Verified entirely by isolated Rust unit tests — `range`/`within` results match an O(N²) brute-force scan over the same Points (workload shape from `refs/kdbush/bench.js`: 1M Points, 10k small bbox + 10k small radius queries). This is sub-seam A: it de-risks the clustering layer by isolating index bugs from clustering-logic bugs. The index never gets a wasm-bindgen surface — it stays opaque in WASM linear memory per ADR 0002.

**Blocked by:** 01 (benchmark harness and oracle machinery) — waits for dataset-generation consistency.

**Status:** resolved

- [x] Cargo workspace skeleton exists and builds
- [x] Floyd–Rivest kd-sort bulk-build produces a queryable Spatial Index from a flat Point array
- [x] `range(minX, minY, maxX, maxY)` returns Point ids matching a brute-force bbox scan
- [x] `within(qx, qy, r)` returns Point ids matching a brute-force radius scan
- [x] Isolated unit tests pass against brute-force on 1M Points with 10k bbox + 10k radius queries
- [x] Zero external spatial-index crate dependencies

## Answer

Implemented in commit `712b549` on `temp` (`feat(kdbush): hand-ported static kd-tree spatial index (ticket 02)`). The `kdbush` crate ports Floyd–Rivest bulk-build kd-sort + iterative-DFS `range`/`within` (circle-bbox pruning + squared-distance post-filter), f32 coords, mirroring `refs/kdbush/index.js` algorithmically. Isolated unit tests verify `range`/`within` against an O(N²) brute-force scan over the `refs/kdbush/bench.js` workload shape (1M points, 10k bbox + 10k radius queries). Zero external spatial-index dependencies; also establishes the Cargo workspace skeleton the rest of the library builds on. Sub-seam A green — index bugs isolated from clustering-logic bugs.
