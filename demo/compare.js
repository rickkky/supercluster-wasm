// Compare page (ticket 13 follow-up): split-screen A/B of deployment
// shapes over the same dataset.
//
// Left pane: wasm-worker — the production chain (js/index.js -> js/worker.js
// -> pkg/supercluster.wasm), fixed. Right pane: a selectable engine (js /
// js-worker / wasm, see engines.js). Both maps share ONE ol/View instance,
// so any pan/zoom on either map moves the other in lockstep — no manual
// sync wiring, and the viewports are identical by construction.
//
// The two sides take DIFFERENT input paths by design: the left wasm-worker
// takes the load_coords fast path (a transferred Float64Array — zero-copy
// into the worker, no GeoJSON parse in Rust), the right engine takes the
// GeoJSON Feature[] input (its only common input shape). The two generator
// variants are coordinate-identical for the same (n, seed), so the clusters
// line up. Consequence (Q8): the coords path carries no properties, so the
// left clusters show count only — no totalValue second line.
//
// Each pane's HUD shows its own load ms (including that engine's input tax)
// and the latest getClusters ms + result count, refreshed on moveend.

import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import GeoJSON from 'ol/format/GeoJSON.js';

import { generateClusteredGeoJSON, generateClusteredCoords } from './data.js';
import { ENGINES } from './engines.js';

const SEED = 42;
// No Aggregation Spec on the compare page: the left pane's load_coords fast
// path carries no properties anyway (Q8), and dropping the spec removes the
// map/reduce callback tax from the right JS engines' load — a pure-clustering
// comparison, like-for-like with the coords side.
const geojsonFormat = new GeoJSON();

// --- shared view + two maps -------------------------------------------------

// One View shared by both maps: pan/zoom on either map drives both. The
// viewports are identical by construction — the comparison is like-for-like.
const view = new View({ center: fromLonLat([110, 32]), zoom: 3 });

// Gaode (Amap) raster tiles — same basemap choice as the single-map demo
// (the only reachable tile host on this network; GCJ-02 offset applies).
function basemap() {
  return new TileLayer({
    source: new XYZ({
      url: 'https://webrd0{1-4}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      maxZoom: 18,
      crossOrigin: 'anonymous',
    }),
  });
}

// Each pane owns its own VectorSource — the two engines return distinct
// Feature object graphs, never shared.
function clusterLayer() {
  return new VectorLayer({ source: new VectorSource(), style: clusterStyle });
}

const mapLeft = new Map({ target: 'map-left', view, layers: [basemap(), clusterLayer()] });
const mapRight = new Map({ target: 'map-right', view, layers: [basemap(), clusterLayer()] });

// --- styling (same conventions as the single-map demo) ---------------------

function clusterStyle(feature) {
  const count = feature.get('point_count') ?? 0;
  if (!count) return pointStyle(feature);
  return new Style({
    image: new CircleStyle({
      radius: 10 + Math.min(18, Math.log2(count + 1) * 2),
      fill: new Fill({ color: 'rgba(220, 60, 60, 0.55)' }),
      stroke: new Stroke({ color: '#a22', width: 1.5 }),
    }),
    text: new Text({
      text: String(count),
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: '#600', width: 2 }),
      font: 'bold 11px system-ui',
    }),
  });
}

function pointStyle() {
  return new Style({
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({ color: 'rgba(70, 130, 220, 0.8)' }),
      stroke: new Stroke({ color: '#fff', width: 1.5 }),
    }),
  });
}

// --- state ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const hudLeft = $('hud-left');
const hudRight = $('hud-right');
const tagRight = $('tag-right');

let engineLeft = null;
let engineRight = null;
let loading = false;
// Per-pane load-time half of the HUD, kept as state so the query half can
// prefix it without re-parsing rendered text.
let loadSummaryLeft = '';
let loadSummaryRight = '';
// Latest per-side timings, mirrored into the center comparison panel.
let lastLoadMsLeft = null;
let lastLoadMsRight = null;
let lastQueryMsLeft = null;
let lastQueryMsRight = null;

const ENGINE_LABELS = {
  'wasm-worker-geojson': 'wasm-worker (geojson)',
  wasm: 'wasm ffi (main thread)',
  js: 'js direct (main thread)',
  'js-worker': 'js-worker',
};

function setHud(el, text) {
  el.textContent = text;
}

// --- load -------------------------------------------------------------------

async function loadBoth() {
  if (loading) return;
  loading = true;
  $('reload').disabled = true;

  const n = Number($('size').value);
  const rightKind = $('engine').value;
  const radius = Number($('radius').value);
  const maxZoom = Number($('max-zoom').value);
  const options = { maxZoom, radius };

  setHud(hudLeft, `generating ${n.toLocaleString()} points…`);
  setHud(hudRight, `generating ${n.toLocaleString()} points…`);
  tagRight.textContent = ENGINE_LABELS[rightKind];
  await yieldToPaint();

  // One generation per input variant: the left wasm-worker takes the
  // load_coords fast path (transferred Float64Array), the right engine takes
  // GeoJSON. The two variants are coordinate-identical for the same (n,
  // seed), so the clusters line up across the panes.
  const tGen = performance.now();
  const { coords, geo } = generateInputs(n, SEED);
  const genMs = performance.now() - tGen;
  const genLine = `generate ${fmtMs(genMs)}`;

  // Tear down the previous engines before constructing new ones.
  if (engineLeft) engineLeft.terminate();
  if (engineRight) engineRight.terminate();
  engineLeft = new ENGINES['wasm-worker']();
  engineRight = new ENGINES[rightKind]();

  setHud(hudLeft, `${genLine}\nbuilding (wasm-worker, coords)…`);
  setHud(hudRight, `${genLine}\nbuilding (${ENGINE_LABELS[rightKind]}, geojson)…`);
  await yieldToPaint();

  // Load sequentially, each side timed separately. Concurrent loads would
  // poison the timings: the main-thread engines (wasm, js) would block the
  // worker engines' response callbacks, and two main-thread engines would
  // contend for the same thread. Sequential keeps every number attributable
  // to its own engine.
  const tL = performance.now();
  await engineLeft.load(coords, options);
  const loadMsLeft = performance.now() - tL;
  const tR = performance.now();
  await engineRight.load(geo, options);
  const loadMsRight = performance.now() - tR;

  loadSummaryLeft = `${genLine}\nload(wasm-worker, coords) ${fmtMs(loadMsLeft)}`;
  loadSummaryRight = `${genLine}\nload(${rightKind}, geojson) ${fmtMs(loadMsRight)}`;
  lastLoadMsLeft = loadMsLeft;
  lastLoadMsRight = loadMsRight;
  lastQueryMsLeft = null;
  lastQueryMsRight = null;
  setHud(hudLeft, loadSummaryLeft);
  setHud(hudRight, loadSummaryRight);
  updateComparePanel();

  loading = false;
  $('reload').disabled = false;
  await refreshBoth();
}

// --- viewport query (moveend) ----------------------------------------------

let refreshQueued = false;
for (const m of [mapLeft, mapRight]) {
  m.on('moveend', () => {
    if (refreshQueued || loading || !engineLeft || !engineRight) return;
    refreshQueued = true;
    // Coalesce: the two maps' moveends for one gesture land back-to-back;
    // query once for both.
    setTimeout(() => {
      refreshQueued = false;
      if (!loading && engineLeft && engineRight) refreshBoth();
    }, 50);
  });
}

function viewportBbox() {
  const extent = view.calculateExtent(mapLeft.getSize());
  // Same antimeridian handling as the single-map demo: at low zoom the
  // projected extent spills past the EPSG:3857 world edge — toLonLat wraps
  // the spill over the antimeridian (the library's min>max split covers both
  // segments); a viewport wider than the world needs the explicit
  // whole-world bbox.
  const WORLD_SPAN = 2 * 20037508.342789244;
  if (extent[2] - extent[0] >= WORLD_SPAN) {
    const [, s] = toLonLat([0, extent[1]]);
    const [, n] = toLonLat([0, extent[3]]);
    return [-180, s, 180, n];
  }
  const [w, s] = toLonLat([extent[0], extent[1]]);
  const [e, n] = toLonLat([extent[2], extent[3]]);
  return [w, s, e, n];
}

async function refreshBoth() {
  const bbox = viewportBbox();
  const zoom = Math.round(view.getZoom());

  const tL = performance.now();
  const fL = await engineLeft.getClusters(bbox, zoom);
  const msL = performance.now() - tL;

  const tR = performance.now();
  const fR = await engineRight.getClusters(bbox, zoom);
  const msR = performance.now() - tR;

  render(mapLeft, fL);
  render(mapRight, fR);

  lastQueryMsLeft = msL;
  lastQueryMsRight = msR;
  setHud(hudLeft, `z${zoom}\n${loadSummaryLeft}\ngetClusters ${fmtMs(msL)} · ${fL.length} results`);
  setHud(hudRight, `z${zoom}\n${loadSummaryRight}\ngetClusters ${fmtMs(msR)} · ${fR.length} results`);
  updateComparePanel();
}

// --- center comparison panel -------------------------------------------------

// The center panel mirrors both panes' latest timings and shows the
// wasm-worker-coords advantage as a ratio: how many times slower the right
// engine's load / query is than the left's. A ratio < 1 means the right
// engine was faster.
function updateComparePanel() {
  const el = $('compare-panel');
  if (!el) return;
  if (lastLoadMsLeft == null || lastLoadMsRight == null) {
    el.textContent = '';
    return;
  }
  const rows = [`load    ${fmtMs(lastLoadMsLeft)}  vs  ${fmtMs(lastLoadMsRight)}   (${ratio(lastLoadMsLeft, lastLoadMsRight)})`];
  if (lastQueryMsLeft != null && lastQueryMsRight != null) {
    rows.push(`query   ${fmtMs(lastQueryMsLeft)}  vs  ${fmtMs(lastQueryMsRight)}   (${ratio(lastQueryMsLeft, lastQueryMsRight)})`);
  }
  el.textContent = rows.join('\n');
}

// Ratio of left to right, phrased as "left is Nx faster" (or slower).
function ratio(msLeft, msRight) {
  const r = msRight / msLeft;
  if (r >= 1) return `${r.toFixed(1)}x faster`;
  return `${(1 / r).toFixed(1)}x slower`;
}

function render(map, features) {
  const source = map.getLayers().item(1).getSource();
  source.clear();
  if (features.length) {
    source.addFeatures(
      geojsonFormat.readFeatures(
        { type: 'FeatureCollection', features },
        { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' },
      ),
    );
  }
}

// --- wiring -----------------------------------------------------------------

$('reload').addEventListener('click', loadBoth);
loadBoth();

// --- helpers ----------------------------------------------------------------

// Generate the two coordinate-identical input variants for one (n, seed):
// coords (Float64Array, for the left wasm-worker's load_coords fast path)
// and geo (GeoJSON Feature[], for the right engine). The coords buffer is
// transferred into the worker on load — a fresh pair is generated per Load.
function generateInputs(n, seed) {
  const { coords } = generateClusteredCoords(n, seed);
  const geo = generateClusteredGeoJSON(n, seed);
  return { coords, geo };
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
// Yield to the event loop so HUD updates paint before a blocking stretch.
// setTimeout, not rAF: rAF never fires in a background tab, which would
// hang the load sequence the moment the tab loses focus.
function yieldToPaint() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
