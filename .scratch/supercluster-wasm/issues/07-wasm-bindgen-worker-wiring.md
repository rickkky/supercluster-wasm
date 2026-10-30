# 07 — wasm-bindgen boundary and Web Worker wiring

**What to build:** The WASM↔JS boundary (sub-seam B): wrap the full Rust API with `wasm-bindgen` + `wasm-pack` (target web/bundler), bootstrap a single Web Worker, expose the API as async JS methods, and implement the compact typed-array result contract — query results are written into a freshly allocated per-query buffer in WASM linear memory, JS reads them via a zero-copy `Float32Array` view and assembles GeoJSON on the JS side. The Spatial Index stays opaque in WASM linear memory (ADR 0002); the kdbush serialized format is not reproduced. Ship TypeScript type definitions. Verified by the boundary contract: the typed array a WASM call returns decodes to the expected id+coord+count+cluster/point-tag set for a given query.

**Blocked by:** 05 (Cluster Hierarchy API) and 06 (declarative aggregation) — the full Rust API must exist before wrapping.

**Status:** resolved

- [ ] Full Rust API exported via `wasm-bindgen` + `wasm-pack` (target web/bundler)
- [ ] Single Web Worker bootstraps; API exposed as async JS methods
- [ ] Query results cross the boundary as compact typed arrays written to a fresh per-query buffer
- [ ] JS reads results via zero-copy `Float32Array` view and assembles GeoJSON
- [ ] Spatial Index stays opaque in WASM linear memory; no buffer transfer to JS
- [ ] TypeScript type definitions shipped
- [ ] Boundary contract verified: typed array decodes to expected id+coord+count+tag set

## Answer

`resolved` in `36dd4e2` (full suite green). The WASM↔JS boundary (sub-seam B):

- **`crates/supercluster`** — `wasm` feature (wasm-bindgen/js-sys optional, `crate-type =
  cdylib+rlib`). `src/encode.rs` is a **pure-Rust encoder** (not feature-gated) — the TDD
  entry point, testable with plain `cargo test` (Tier 1, 6 tests). `src/wasm.rs` is the thin
  FFI shell: `SuperclusterWasm` with `load`/`get_clusters`/`get_children`/`get_leaves`/
  `get_cluster_expansion_zoom`. `load` parses GeoJSON via `js-sys` (crate stays serde-free
  in release) and populates the ticket-06-deferred `numeric_props` sidecar from the spec's
  named source properties; `properties` is left `None` (main thread keeps originals).
- **Typed-array contract = Float64Array** (both buffers), reconciling the spec's
  "Float32Array view" wording to ADR 0003's f64-cluster-center amendment (decided with
  Ricky — f32 would lose ~2m coordinate precision and risk aggregated-sum overflow; u32
  ids/counts as f64 are exact < 2^53). Row stride 5: `[lng, lat, id, num_points, tag]`
  (tag 0=point, 1=cluster); aggregated stride = `spec_len`. Each query writes fresh
  per-query buffers (no scratch reuse → no `Float64Array::view` aliasing UB).
- **`js/`** — ESM module worker (`worker.js`) owns one `SuperclusterWasm`; `init()` then
  construct (the init race that broke Tier 4 first run — `superclusterwasm_new` undefined
  when constructed before `init()` resolved). Main-thread async wrapper (`index.js`)
  promise-correlated over postMessage; `decode.js` assembles GeoJSON (clusters synthesized
  with `point_count_abbreviated`, points recovered by `feature_id` indexing the
  geometry-bearing subset). TypeScript defs in `index.d.ts`.
- **`.cargo/config.toml`** pins `wasm-bindgen-test-runner` for the wasm32 target —
  wasm-pack 0.14.0 does not intercept the default harness, and `wasm-bindgen-test` is
  pinned to 0.3.x to match the 0.2.127 runner's discovery format (the 0.2.x macro emits
  `__wbg_test_*` exports the 0.2.127 runner no longer scans for).
- **Verification** — Tiers 1-3 are the committed CI gate (18 native + 4 wasm32 + 7 node
  decode tests, all green). Tier 4 browser smoke (`test/wasm-smoke.html`, MCP-driven,
  **not** in CI) verified SMOKE OK end-to-end: 163 features loaded, z0 → 32 features
  (cluster+point), `getChildren(164)` → 4, `getClusterExpansionZoom(164)` → 1,
  `getLeaves(164)` → 16. ADR 0002 honored: the index stays opaque in WASM linear memory;
  only result data crosses (worker copies the zero-copy views and transfers the copies —
  WASM-memory views can't be transferred).

**Code review** (two-axis, `/code-review`): no hard standards violations; 5 minor
judgement-call smells (duplicated `js_set`/`specFieldNames` shapes, long bbox-coercion
line, speculative "forward-compat" tag comment, near-identical query delegators). Spec
findings were either documented decisions (`Box::leak` for `&'static str` spec fields —
plan R3, bounded) or misreadings reconciled against ADR 0002 ("no buffer transfer" refers
to the index, not result data) and the Tier 4 smoke (the `--target web` ESM import and
`getLeaves` null-limit both verified working). Committed as-is per Ricky.
