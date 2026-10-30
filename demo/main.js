// Demo main (ticket 13): OpenLayers + the production WASM worker wrapper.
//
// This exercises the real deployment chain in a real browser —
// js/index.js (module worker) -> js/worker.js -> pkg/supercluster.wasm —
// which no Node test can run (worker_threads cannot host the browser-style
// module worker over pkg/).
//
// Integration pattern: a plain ol/layer/Vector over an ol/source/Vector,
// re-queried on `moveend` via the library's getClusters(bbox, zoom) — the
// "drop-in getClusters consumer" pattern. OL's own ol/source/Cluster is
// deliberately NOT used: it clusters in JS on the main thread, which would
// defeat the point of validating OUR WASM clustering.
//
// UI linkage (ticket 13 Q8): load_coords carries no source features, so the
// getClustersIds path's Point rows would degrade to null-geometry. With the
// coords build path active the ids toggle is disabled with a hint — the demo
// measures production paths, it does not patch the library.

import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import GeoJSON from 'ol/format/GeoJSON.js';

import { Supercluster } from '../js/index.js';
import { generateClusteredGeoJSON, generateClusteredCoords } from './data.js';

const SEED = 42;
const AGGREGATION_SPEC = {
  fields: [{ name: 'totalValue', prop: 'value', op: 'sum' }],
};
const geojsonFormat = new GeoJSON();

// --- map scaffolding -------------------------------------------------------

const source = new VectorSource();
const clusterLayer = new VectorLayer({
  source,
  style: clusterStyle,
});
const map = new Map({
  target: 'map',
  // Gaode (Amap) raster tiles: the only basemap reachable from this network
  // (tile.openstreetmap.org times out). GCJ-02 offset applies — tile imagery
  // is shifted a few hundred meters from the WGS84 cluster coordinates; fine
  // for a texture basemap, not for strict alignment.
  layers: [
    new TileLayer({
      source: new XYZ({
        url: 'https://webrd0{1-4}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        maxZoom: 18,
        crossOrigin: 'anonymous',
      }),
    }),
    clusterLayer,
  ],
  view: new View({ center: fromLonLat([10, 30]), zoom: 2 }),
});

// Unclustered points are colored by their distance-to-seed value: the
// closer to the seed center, the deeper in a red -> orange -> yellow ->
// green ramp. The value is meters (haversine); DIST_MAX is the
// normalization ceiling (~2 sigma of the generator's scatter, ~30 km at
// mid-latitude) —
// anything beyond renders at the ramp's end (green). GeoJSON load: the
// value rides the feature's own properties. coords load: the decoded point
// is property-less, so the props table is joined by feature_id at style
// time (same join as the click inspect).
const DIST_MAX = 30000;
// Red -> orange -> yellow -> light-green stops with hand-tuned positions:
// red holds the first half (most points cluster near the seed under the
// Gaussian scatter), yellow is a narrow band near the end, and the ramp
// ends in a soft light green (not deep green).
const DIST_RAMP = [
  [0.0, 220, 20, 30], // red — at the seed
  [0.5, 255, 140, 0], // orange
  [0.85, 255, 230, 0], // yellow — narrow band
  [1.0, 154, 205, 50], // light green — farthest
];
function rampColor(t) {
  let seg = 0;
  while (seg < DIST_RAMP.length - 2 && t > DIST_RAMP[seg + 1][0]) seg++;
  const [t1, r1, g1, b1] = DIST_RAMP[seg];
  const [t2, r2, g2, b2] = DIST_RAMP[seg + 1];
  const f = t2 > t1 ? Math.min(1, Math.max(0, (t - t1) / (t2 - t1))) : 0;
  return `rgb(${Math.round(r1 + (r2 - r1) * f)}, ${Math.round(g1 + (g2 - g1) * f)}, ${Math.round(b1 + (b2 - b1) * f)})`;
}
function pointStyleFor(feature) {
  let value = feature.get('value');
  if (typeof value !== 'number' && pointProps) {
    const p = pointProps[feature.getId()];
    value = p ? p.value : undefined;
  }
  // t in [0, 1]: 0 = at the seed (red), 1 = at/over DIST_MAX (green).
  const t = typeof value === 'number' ? Math.min(1, value / DIST_MAX) : 1;
  return new Style({
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({ color: rampColor(t) }),
      stroke: new Stroke({ color: '#fff', width: 1.5 }),
    }),
  });
}
function clusterStyle(feature) {
  const count = feature.get('point_count') ?? 0;
  if (!count) return pointStyleFor(feature);
  const total = feature.get('totalValue');
  const lines = [String(count)];
  // The aggregate only exists on the GeoJSON load path (load_coords carries
  // no numeric_props); a 0/undefined total means no spec data — show count
  // only rather than a meaningless 0.
  if (typeof total === 'number' && total > 0) lines.push(abbreviate(total));
  return new Style({
    image: new CircleStyle({
      radius: 10 + Math.min(18, Math.log2(count + 1) * 2),
      fill: new Fill({ color: 'rgba(220, 60, 60, 0.55)' }),
      stroke: new Stroke({ color: '#a22', width: 1.5 }),
    }),
    text: new Text({
      text: lines.join('\n'),
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: '#600', width: 2 }),
      font: 'bold 11px system-ui',
    }),
  });
}
// supercluster's abbreviation convention (>=10000 -> "Nk", >=1000 -> "N.Mk").
function abbreviate(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

// --- state -----------------------------------------------------------------

let sc = null;
let loading = false;
// The load-time half of the HUD (gen + build ms), kept as state so the
// query half can prefix it without re-parsing rendered text.
let loadSummary = '';
// Props table for the load_coords path (Q8): coords input carries no
// properties, but every decoded point row keeps its feature_id (= input
// index), so a clicked point joins back via pointProps[fid]. Geometry via
// WASM, attributes self-held by the consumer. Null on the GeoJSON path
// (points recover the original source feature with its own properties).
let pointProps = null;

const $ = (id) => document.getElementById(id);
const hud = $('hud');
const drill = $('drill');
const hint = $('hint');

function setHud(text) {
  hud.textContent = text;
}
function setHint(text) {
  hint.textContent = text;
}
function logDrill(line) {
  const at = new Date().toLocaleTimeString();
  drill.textContent = `[${at}] ${line}\n` + drill.textContent;
}

// --- load ------------------------------------------------------------------

async function loadDataset() {
  if (loading) return;
  loading = true;
  const n = Number($('size').value);
  const buildPath = $('build-path').value;
  // Cluster radius in pixels (supercluster's `radius` option): the distance
  // below which points merge into one cluster at a given zoom. Bigger
  // radius -> fewer, larger clusters. Changing it requires a rebuild.
  const radius = Number($('radius').value);
  // Highest zoom that clusters; above it the raw points show unclustered.
  // Higher = more lattice levels built = longer build, more memory.
  const maxZoom = Number($('max-zoom').value);
  setHud(`generating ${n.toLocaleString()} points…`);

  // Generation is on the main thread and timed separately — its cost is
  // honest and visible (Q4).
  await raf();
  const tGen = performance.now();
  let geo = null;
  let coords = null;
  let propsTable = null;
  if (buildPath === 'geojson') {
    geo = generateClusteredGeoJSON(n, SEED);
  } else {
    ({ coords, props: propsTable } = generateClusteredCoords(n, SEED));
  }
  const genMs = performance.now() - tGen;

  if (sc) sc.terminate();
  sc = new Supercluster();
  await sc.ready;

  setHud(`building (${buildPath})…`);
  await raf();
  const tLoad = performance.now();
  if (buildPath === 'coords') {
    pointProps = propsTable;
    await sc.load(coords, { maxZoom, radius, aggregation: AGGREGATION_SPEC });
    // coords was transferred (buffer detached) — do not reuse it. The props
    // table is plain JS objects, unaffected by the transfer.
  } else {
    pointProps = null; // GeoJSON points recover their own source feature
    await sc.load(geo, { maxZoom, radius, aggregation: AGGREGATION_SPEC });
  }
  const loadMs = performance.now() - tLoad;

  // Ids-path gating (Q8): the coords path holds no source features, so the
  // ids query path's Point rows would degrade to null-geometry — disable it.
  const idsSelect = $('query-path');
  if (buildPath === 'coords') {
    idsSelect.value = 'clusters';
    idsSelect.disabled = true;
    setHint('ids query path unavailable with load_coords — switch Build path to GeoJSON to enable.');
  } else {
    idsSelect.disabled = false;
    setHint('');
  }

  setHud(`generate ${fmtMs(genMs)} · load(${buildPath}) ${fmtMs(loadMs)} · ${n.toLocaleString()} pts`);
  loadSummary = `generate ${fmtMs(genMs)}\nload(${buildPath}) ${fmtMs(loadMs)}`;
  logDrill(`load ${buildPath}: gen ${fmtMs(genMs)}, build ${fmtMs(loadMs)}`);
  loading = false;
  await refresh();
}

// --- viewport query (moveend) ----------------------------------------------

let refreshQueued = false;
map.on('moveend', () => {
  if (refreshQueued || loading || !sc) return;
  refreshQueued = true;
  // Coalesce: the fly-to animation fires several moveends; query once.
  setTimeout(() => {
    refreshQueued = false;
    if (!loading && sc) refresh();
  }, 50);
});

async function refresh() {
  const view = map.getView();
  const extent = view.calculateExtent(map.getSize());
  // Extent corners are map projections; convert to lon/lat corners. At low
  // zooms the projected extent spills past the EPSG:3857 world edge
  // (±20037508 m) — OL is showing a wrapped world copy there. toLonLat
  // wraps the spill back over the antimeridian (a -25M corner becomes
  // +135.4°), which is exactly what the library's antimeridian split
  // expects: a bbox whose min > max is queried as [min, 180] ∪ [-180, max],
  // covering both the canonical world and the visible copy. Only a viewport
  // wider than the whole world needs the explicit whole-world bbox (both
  // corners wrap, and a split would miss the middle).
  const WORLD_SPAN = 2 * 20037508.342789244;
  let bbox;
  if (extent[2] - extent[0] >= WORLD_SPAN) {
    const [, s] = toLonLat([0, extent[1]]);
    const [, n] = toLonLat([0, extent[3]]);
    bbox = [-180, s, 180, n];
  } else {
    const [w, s] = toLonLat([extent[0], extent[1]]);
    const [e, n] = toLonLat([extent[2], extent[3]]);
    bbox = [w, s, e, n];
  }
  const zoom = Math.round(view.getZoom());

  const queryPath = $('query-path').value;
  const t = performance.now();
  const features = queryPath === 'ids'
    ? await sc.getClustersIds(bbox, zoom)
    : await sc.getClusters(bbox, zoom);
  const queryMs = performance.now() - t;

  source.clear();
  if (features.length) {
    // OL's GeoJSON reader wants a FeatureCollection and lon/lat -> map
    // projection conversion.
    source.addFeatures(
      geojsonFormat.readFeatures(
        { type: 'FeatureCollection', features },
        { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' },
      ),
    );
  }

  const qLabel = queryPath === 'ids' ? 'getClustersIds' : 'getClusters';
  setHud(`z${zoom}\n${loadSummary}\n${qLabel} ${fmtMs(queryMs)} · ${features.length} results`);
}

// --- click (drilldown + point inspect) --------------------------------------

map.on('singleclick', async (evt) => {
  if (!sc || loading) return;
  const hit = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
  if (!hit) return;

  const clusterId = hit.get('cluster_id');
  if (clusterId == null) {
    // An unclustered point. GeoJSON load: the query decode returns the
    // original source feature, so its own properties are inspectable.
    // coords load: the decoded point is synthesized with empty properties
    // but keeps its feature_id — join back through the consumer-held props
    // table (geometry via WASM, attributes self-held; Q8).
    // The feature_id rides the GeoJSON feature-level `id` field, which OL's
    // reader turns into feature.setId() — read it via getId(), not get('id').
    const fid = hit.getId();
    if (pointProps && Number.isInteger(fid)) {
      const p = pointProps[fid];
      if (p) {
        logDrill(`point #${fid}: pid=${p.pid} · city=${p.city} · value=${p.value}`);
        return;
      }
    }
    const props = hit.getProperties();
    delete props.geometry;
    const entries = Object.entries(props);
    logDrill(
      entries.length
        ? `point: ${entries.map(([k, v]) => `${k}=${v}`).join(' · ')}`
        : 'point: no properties',
    );
    return;
  }

  const t0 = performance.now();
  const expansionZoom = await sc.getClusterExpansionZoom(clusterId);
  const t1 = performance.now();
  const children = await sc.getChildren(clusterId);
  const t2 = performance.now();
  const leaves = await sc.getLeaves(clusterId, 10, 0);
  const t3 = performance.now();

  logDrill(
    `cluster ${clusterId}: expansionZoom ${expansionZoom} (${fmtMs(t1 - t0)}) · ` +
    `getChildren ${children.length} (${fmtMs(t2 - t1)}) · ` +
    `getLeaves ${leaves.length} (limit 10) (${fmtMs(t3 - t2)})`,
  );

  // Fly to the zoom where the cluster breaks apart (the classic
  // supercluster-demo interaction); moveend re-queries the viewport.
  const geom = hit.getGeometry();
  const [lng, lat] = toLonLat(geom.getCoordinates());
  map.getView().animate({ center: fromLonLat([lng, lat]), zoom: expansionZoom, duration: 500 });
});

// --- wiring ----------------------------------------------------------------

$('reload').addEventListener('click', loadDataset);
loadDataset();

// --- helpers ---------------------------------------------------------------

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
function raf() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
