# 13 — Frontend browser demo (OpenLayers + WASM clustering)

**What to build:** a browser demo under `demo/` that exercises the
production `js/index.js` wrapper end-to-end in a real browser — the path
that has never actually run in a browser (all Node tests mock or port the
worker mechanics). OpenLayers + OSM raster tiles as the map, a plain
`VectorLayer` + `moveend` listener re-querying `getClusters(bbox, zoom)` and
rebuilding the source (the "drop-in getClusters consumer" pattern; OL's own
`ol/source/Cluster` is deliberately bypassed — the demo validates OUR
clustering, not OL's). No bundler: wasm-pack's `--target web` output is
plain ESM, served statically.

**Decisions (grilled with Ricky, Q1-Q12):**

- **Q1 Scope:** Clustering is the main act; Aggregation Spec is the
  side-show (points carry a population-like numeric value; spec
  `{name:'totalValue', prop:'value', op:'sum'}`; cluster labels show
  count + abbreviated aggregate). Terms distinguished per CONTEXT.md.
- **Q2 Positioning:** real-browser full-chain validation + lightweight
  perf HUD (load ms, per-viewport-query ms, drilldown ms/count). Not a
  consumer template.
- **Q3 Map:** OpenLayers (not MapLibre) + OSM tiles.
- **Q4 Data:** runtime-generated clustered shape (city centers +
  Gaussian scatter, distance-to-seed value), sizes 100k / 500k / 1M / 5M,
  default 1M. Generation on the main thread (its cost is visible and
  honest).
- **Q5 Build path:** `load_coords` (transferred, zero-copy) by default;
  a toggle switches to GeoJSON `load` to compare load times.
- **Q6 Interactions:** viewport re-query on moveend; click-to-drill
  (`getClusterExpansionZoom` fly-to); query-path toggle
  (`getClusters` vs `getClustersIds`); sidebar debug panel logging
  getChildren/getLeaves counts + ms.
- **Q7 OL integration:** plain VectorLayer + moveend rebuild (option a).
- **Q8 Semantic conflict:** `load_coords` holds no source features, so
  the ids path's Point rows degrade to null-geometry. UI linkage: with
  load_coords active the ids toggle is DISABLED with a hint (the demo
  measures production paths; it does not patch the library by holding a
  shadow dataset). load_coords labels show count only (no aggregate —
  no numeric_props on the fast path).
- **Q9 Sizes:** 100k / 500k / 1M / 5M, default 1M.
- **Q10 Aggregate display:** two-line cluster labels (count + aggregate).
- **Q11 Drilldown:** expansionZoom fly-to + sidebar panel recording
  getChildren/getLeaves counts and ms per click.
- **Q12 Serving:** `demo/serve.mjs` — a ~30-line zero-dependency Node
  static file server; `pnpm demo` runs it (after `pnpm wasm:build`).
  OpenLayers is a devDependency (build-time only).

**Constraints:**

- No production `js/` changes. Demo-only, mirrors the bench-only
  discipline of tickets 09-12.
- The demo tests production paths (`js/index.js`, `js/worker.js`,
  `js/decode.js`, `pkg/`), not a parallel implementation.
- English-only comments; pnpm; no bundler.

**Status:** resolved

- [x] `demo/serve.mjs` — zero-dependency static server (content types for
      .html/.js/.mjs/.wasm/.json/.css), port 5177
- [x] `demo/index.html` — map container + controls (dataset size, build
      path, query path) + HUD + drilldown panel
- [x] `demo/main.js` — OL map + moveend → getClusters/getClustersIds +
      decode → VectorSource rebuild; click → expansionZoom fly-to +
      getChildren/getLeaves panel logging
- [x] `demo/data.js` — clustered dataset generator (city centers +
      Gaussian scatter + distance-to-seed value), 100k/500k/1M/5M
- [x] `package.json` — `demo` script; OpenLayers devDependency
- [x] `pnpm wasm:build` + browser verification: load (both paths), pan/zoom
      re-query, ids toggle gating, drilldown fly-to, HUD numbers sane
- [x] Full test suite still green (no production changes)

## Answer

**Delivered:** `demo/` (serve.mjs, index.html, main.js, data.js) +
`pnpm demo` + `ol` devDependency. All flows verified in Chrome against the
production chain (js/index.js → js/worker.js → pkg/supercluster.wasm):

- **coords load (1M):** gen 132 ms, build 685 ms; viewport queries 0.5-0.9 ms,
  516-668 clusters @z3-z4. Ids toggle correctly disabled with hint (Q8).
- **GeoJSON load (100k):** gen 79 ms, build 338 ms (16x slower per point than
  coords, confirming the ticket-08 parse-bound finding). 340/340 clusters
  carry a positive `totalValue` aggregate; labels show count + abbreviated
  total (Q10). Ids toggle re-enabled.
- **ids query path (GeoJSON build):** getClustersIds 0.9 ms, 191 results @z4.
- **Drilldown:** cluster 1003237 → expansionZoom 5 (0.4 ms), getChildren 8
  (0.2 ms), getLeaves 10 (0.4 ms), fly-to animation re-queries on moveend.

**Found and fixed one production bug** (the demo's purpose — first real-
browser run of the full chain — caught it): `build_point_features`
(crates/supercluster/src/wasm.rs) stored `numeric_props` under the spec
field's output `name`, but the build loop folds via
`get_numeric(spec_field.prop)` (lattice.rs) — any spec whose `name` ≠ `prop`
folded to the identity (sum 0). The JS-oracle fixtures all use name === prop,
and the native aggregation oracle bypasses the WASM boundary, so no existing
tier caught it. Regression test added
(`wasm_boundary::aggregation_sidecar_keyed_by_source_prop_not_spec_name`,
verified red against the old code, green after the fix); pkg rebuilt; full
suite green (55 tests).

Demo-only notes: no bundler — an import map maps `ol/` to /node_modules/ol/
plus explicit pnpm-layout entries for rbush/quickselect (OL's transitive
deps). At low zoom the projected extent spills past the EPSG:3857 world edge
and `toLonLat` wraps it over the antimeridian (zero-width bbox) — the demo
clamps the extent to ±20037508 m before converting.

**Follow-ups (post-review iterations, all verified in browser):**

- **Basemap switched from OSM to Gaode (Amap) raster tiles**
  (`webrd0{1-4}.is.autonavi.com`, XYZ source): `tile.openstreetmap.org` is
  unreachable from this network (browser fetch times out at ~42 s, curl
  exit 28), while the Gaode tile hosts respond in ~0.2 s. Caveat noted in a
  code comment: Gaode imagery is GCJ-02, offset a few hundred meters from
  the WGS84 cluster coordinates — fine for a texture basemap, not strict
  alignment.
- **"Cluster radius (px)" select** (20 / 40 / 60 default / 80 / 160)
  exposing supercluster's `radius` option — the merge distance in pixels
  per zoom; changing it requires a rebuild. The default was tuned from the
  originally planned 40 to 60 during browser verification (better cluster
  legibility over the China-weighted dataset at z3-z4). Verified @z3 with
  1M points: 20 → 1780, 40 → 516, 80 → 133, 160 → 55 results.
- **"Max cluster zoom" select** (4-18 in steps of 2, default 12) exposing
  `maxZoom` — the highest zoom that clusters; above it raw points show
  unclustered (this was the answer to "why is z9+ scatter-only": the
  default was hardcoded to 8). The option set was widened and the default
  raised from the originally planned 8 to 12 during browser verification
  (keeps clustering active through the zoom levels the demo is actually
  panned through). Build cost scales with lattice levels:
  1M points build 1.3 s @8 vs 11.4 s @16; clustering confirmed still
  active at z9/z11 with maxZoom 16.
- **HUD shows the current zoom level** (`z{N}` prefix, e.g.
  `z4 · generate 132 ms · load(coords) 685 ms · getClusters 0.7 ms · 516
  results`), rendered multi-line (`white-space: pre-line`) — one segment
  per phase instead of the single-line layout first sketched; content and
  ordering match the sketch. The load-time half is kept in a `loadSummary`
  module state instead of re-parsing the rendered HUD text (re-parsing
  picked up the old z-prefix as a segment).
- **`packageManager` pinned to `pnpm@10.34.6`** — pnpm 10 requires an
  exact version in the field; the bare `"pnpm"` failed `pnpm demo` with
  "No version specified for pnpm in packageManager".
- **Split-screen engine comparison page** (`demo/compare.html` +
  `compare.js` + `engines.js` + `js-worker.browser.js`): two OL maps
  sharing ONE `View` instance (pan/zoom on either drives both — identical
  viewports by construction). Left pane fixed to wasm-worker on the
  load_coords FAST PATH (transferred Float64Array); right pane selectable:
  `js direct` (npm supercluster on the main thread, default),
  `js-worker` (the npm package behind a browser module worker,
  `demo/js-worker.browser.js`), `wasm ffi` (SuperclusterWasm directly on
  the main thread), `wasm-worker (geojson)` (the production chain on the
  GeoJSON input path). The two sides take DIFFERENT input paths by design:
  the left takes coords (its fast path), every right engine takes GeoJSON
  (its only common input shape) — the two generator variants are
  coordinate-identical for the same (n, seed), so the clusters line up.
  Per-pane HUD lines: generate / load (including each engine's input tax,
  labeled with the input path) / getClusters ms + results. Loads run
  sequentially so every number is attributable to its own engine.
  Verified in Chrome @500k: wasm-worker coords 0.44-1.1 s vs
  wasm-worker geojson 3.3 s (the GeoJSON parse tax, ticket 08 — the
  original motivation for the coords fast path) vs js direct 0.5 s vs
  js-worker 1.5 s vs wasm ffi 1.95 s; queries 0.3-3.5 ms; identical
  cluster counts both sides at z3/z4. A center comparison panel
  (`#compare-panel`) mirrors both panes' latest load/query timings and
  shows the wasm-worker-coords advantage as a ratio ("Nx faster" / "Nx
  slower" per phase). The compare page passes NO
  Aggregation Spec: the left pane's coords input carries no properties
  anyway (Q8), and dropping the spec removes the map/reduce callback tax
  from the right JS engines' load — a pure-clustering comparison, with
  count-only cluster labels on both sides.
  Gotchas found (all fixed): (1) import maps do NOT apply inside module
  workers — the js-worker imports the UMD dist bundle (kdbush bundled
  inline) via dynamic import + globalThis fallback, since the ESM entry's
  bare `kdbush` specifier cannot resolve in a worker; (2) a load posted to
  the production worker before its WASM init resolves races
  `self.onmessage` assignment and is silently dropped — every engine's
  `load()` now awaits its own `ready` first; (3) rAF-based yields hang in
  background tabs — the compare page yields via setTimeout instead.
- **Default dataset size lowered to 500k** (from Q9's 1M) after browser
  verification — snappier default interaction; 100k / 1M / 5M remain
  selectable and all four sizes were verified.
- **Dataset generator rewritten to a China-weighted real-city corpus**
  (`demo/data.js`): major-city WGS84 coordinates as sampling centers,
  Chinese cities weighted ~5x so most points land on them (readable
  against the Gaode basemap over China), global majors as secondary
  seeds; Gaussian spread tightened to city scale (0.15°/0.1° ≈ 15 km) so
  centers stay visually distinct. Points carry `{pid, city, value}` where
  value is the haversine distance to the seed center in meters (keeps the
  Q4 distance-to-seed value contract; same (n, seed) is
  coordinate-identical across the GeoJSON and coords variants).
- **Click-to-inspect**: clicking an unclustered point logs its
  `{pid, city, value}` in the sidebar; with the coords fast path (no
  source properties, Q8) the demo joins a consumer-held props table by
  `feature_id` at inspect/style time — demo-side state only, the library
  is not patched.
- **Unclustered-point color ramp**: points are styled red → orange →
  yellow → light-green by their distance-to-seed value, normalized by
  `DIST_MAX` (30 km, ~2 sigma of the scatter); beyond the ceiling renders
  at the ramp end. Purely visual — makes the generator's clustered shape
  legible.
- **Antimeridian handling replaced**: the earlier extent clamp was
  replaced by a min>max split bbox on viewport queries (main.js +
  compare.js) — verified against `crates/supercluster/src/query.rs`,
  which implements the same split, so wrapped viewports query correctly.
- **`serve.mjs` `/` now 302-redirects to `/demo/index.html`** (instead of
  serving it from the repo root) so the page's relative imports resolve.
- **Two-axis code review (Standards + Spec) passed with no hard
  violations**: English-only comments, pnpm pin, and CONTEXT.md vocabulary
  all clean; the known judgement-call smells (deliberate duplication of
  `specToMapReduce` / antimeridian bbox / basemap config across the demo
  files, the versioned importmap paths, the unused expansionZoom worker
  message) are accepted for demo-only scope and left as-is.
