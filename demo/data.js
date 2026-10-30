// Demo dataset generator (ticket 13).
//
// Clustered-shape Point data for the browser demo: real major-city
// coordinates (WGS84) are the sampling centers — Chinese cities weighted
// ~5x so most points land on them (readable against the Gaode basemap over
// China), global majors as secondary seeds. Points are Gaussian-scattered
// per center and carry per-point properties for the Aggregation Spec and
// the click-to-inspect interaction: {pid, city, value}, where value is the
// point's distance to its seed center in meters.
//
// Two output variants for the two build paths:
//   generateClusteredGeoJSON(n, seed) — GeoJSON Feature[] (for GeoJSON load
//     + Aggregation Spec + getClustersIds source features)
//   generateClusteredCoords(n, seed)  — flat Float64Array [lng, lat, ...]
//     (for the load_coords fast path; carries no properties by design — Q8)
// The same (n, seed) yields coordinate-identical output across variants, so
// the build-path toggle compares like with like.

// Chinese major cities as {name, lng, lat} (WGS84 coordinates).
export const CHINA_CENTERS = [
  { name: '北京', lng: 116.4074, lat: 39.9042 },
  { name: '上海', lng: 121.4737, lat: 31.2304 },
  { name: '广州', lng: 113.2644, lat: 23.1291 },
  { name: '深圳', lng: 114.0579, lat: 22.5431 },
  { name: '成都', lng: 104.0665, lat: 30.5723 },
  { name: '杭州', lng: 120.1551, lat: 30.2741 },
  { name: '武汉', lng: 114.3054, lat: 30.5928 },
  { name: '西安', lng: 108.9402, lat: 34.3416 },
  { name: '南京', lng: 118.7969, lat: 32.0603 },
  { name: '重庆', lng: 106.5516, lat: 29.5630 },
  { name: '天津', lng: 117.1901, lat: 39.1255 },
  { name: '苏州', lng: 120.5853, lat: 31.2989 },
  { name: '郑州', lng: 113.6254, lat: 34.7466 },
  { name: '长沙', lng: 112.9388, lat: 28.2282 },
  { name: '沈阳', lng: 123.4291, lat: 41.7968 },
  { name: '哈尔滨', lng: 126.5349, lat: 45.8038 },
  { name: '青岛', lng: 120.3826, lat: 36.0671 },
  { name: '大连', lng: 121.6147, lat: 38.9140 },
  { name: '济南', lng: 117.1205, lat: 36.6519 },
  { name: '厦门', lng: 118.0894, lat: 24.4798 },
  { name: '福州', lng: 119.2965, lat: 26.0745 },
  { name: '合肥', lng: 117.2272, lat: 31.8206 },
  { name: '昆明', lng: 102.8329, lat: 25.0453 },
  { name: '贵阳', lng: 106.6302, lat: 26.6477 },
  { name: '南宁', lng: 108.3661, lat: 22.8170 },
  { name: '兰州', lng: 103.8343, lat: 36.0611 },
  { name: '乌鲁木齐', lng: 87.6168, lat: 43.8256 },
  { name: '呼和浩特', lng: 111.7519, lat: 40.8415 },
  { name: '太原', lng: 112.5489, lat: 37.8706 },
  { name: '石家庄', lng: 114.5149, lat: 38.0428 },
  { name: '长春', lng: 125.3245, lat: 43.8868 },
  { name: '宁波', lng: 121.5504, lat: 29.8743 },
  { name: '无锡', lng: 120.3119, lat: 31.4912 },
  { name: '东莞', lng: 113.7518, lat: 23.0207 },
  { name: '佛山', lng: 113.1214, lat: 23.0219 },
  { name: '汕头', lng: 116.6822, lat: 23.3535 },
  { name: '南昌', lng: 115.8581, lat: 28.6832 },
  { name: '常州', lng: 119.4551, lat: 31.7701 },
  { name: '唐山', lng: 118.1802, lat: 39.6309 },
  { name: '海口', lng: 110.1999, lat: 20.0444 },
  { name: '拉萨', lng: 91.1141, lat: 29.6460 },
  { name: '银川', lng: 106.2309, lat: 38.4872 },
  { name: '西宁', lng: 101.7782, lat: 36.6171 },
  { name: '香港', lng: 114.1694, lat: 22.3193 },
  { name: '澳门', lng: 113.5439, lat: 22.1987 },
  { name: '台北', lng: 121.5654, lat: 25.0330 },
];

// Global major cities as {name, lng, lat} (WGS84 coordinates) — secondary
// seeds.
export const GLOBAL_CENTERS = [
  { name: '东京', lng: 139.6917, lat: 35.6895 },
  { name: '大阪', lng: 135.5023, lat: 34.6937 },
  { name: '名古屋', lng: 136.9066, lat: 35.1815 },
  { name: '福冈', lng: 130.4017, lat: 33.5904 },
  { name: '首尔', lng: 126.9780, lat: 37.5665 },
  { name: '釜山', lng: 129.0756, lat: 35.1796 },
  { name: '德里', lng: 77.2090, lat: 28.6139 },
  { name: '孟买', lng: 72.8777, lat: 19.0760 },
  { name: '卡拉奇', lng: 67.0099, lat: 24.8616 },
  { name: '达卡', lng: 90.4125, lat: 23.8103 },
  { name: '曼谷', lng: 100.5018, lat: 13.7563 },
  { name: '雅加达', lng: 106.8456, lat: -6.2088 },
  { name: '马尼拉', lng: 120.9842, lat: 14.5995 },
  { name: '新加坡', lng: 103.8198, lat: 1.3521 },
  { name: '吉隆坡', lng: 101.6869, lat: 3.1390 },
  { name: '胡志明市', lng: 106.6297, lat: 10.8231 },
  { name: '河内', lng: 105.8342, lat: 21.0278 },
  { name: '仰光', lng: 96.1561, lat: 16.8661 },
  { name: '金边', lng: 104.9282, lat: 11.5564 },
  { name: '科伦坡', lng: 79.8612, lat: 6.9271 },
  { name: '塔什干', lng: 69.2401, lat: 41.2995 },
  { name: '阿拉木图', lng: 76.8897, lat: 43.2389 },
  { name: '纽约', lng: -74.0060, lat: 40.7128 },
  { name: '洛杉矶', lng: -118.2437, lat: 34.0522 },
  { name: '芝加哥', lng: -87.6298, lat: 41.8781 },
  { name: '旧金山', lng: -122.4194, lat: 37.7749 },
  { name: '西雅图', lng: -122.3321, lat: 47.6062 },
  { name: '波士顿', lng: -71.0589, lat: 42.3601 },
  { name: '华盛顿', lng: -77.0369, lat: 38.9072 },
  { name: '迈阿密', lng: -80.1918, lat: 25.7617 },
  { name: '休斯敦', lng: -95.3698, lat: 29.7604 },
  { name: '达拉斯', lng: -96.7970, lat: 32.7767 },
  { name: '丹佛', lng: -104.9903, lat: 39.7392 },
  { name: '凤凰城', lng: -112.0740, lat: 33.4484 },
  { name: '多伦多', lng: -79.3832, lat: 43.6532 },
  { name: '温哥华', lng: -123.1216, lat: 49.2827 },
  { name: '蒙特利尔', lng: -73.5674, lat: 45.5019 },
  { name: '墨西哥城', lng: -99.1332, lat: 19.4326 },
  { name: '哈瓦那', lng: -82.3666, lat: 23.1136 },
  { name: '加拉加斯', lng: -66.9036, lat: 10.4806 },
  { name: '圣保罗', lng: -46.6333, lat: -23.5505 },
  { name: '布宜诺斯艾利斯', lng: -58.3816, lat: -34.6037 },
  { name: '里约热内卢', lng: -43.1729, lat: -22.9068 },
  { name: '圣地亚哥', lng: -70.6506, lat: -33.4489 },
  { name: '蒙得维的亚', lng: -56.1645, lat: -34.9011 },
  { name: '利马', lng: -77.0428, lat: -12.0464 },
  { name: '波哥大', lng: -74.0721, lat: 4.7110 },
  { name: '伦敦', lng: -0.1276, lat: 51.5072 },
  { name: '巴黎', lng: 2.3522, lat: 48.8566 },
  { name: '柏林', lng: 13.4050, lat: 52.5200 },
  { name: '马德里', lng: -3.7038, lat: 40.4168 },
  { name: '巴塞罗那', lng: 2.1734, lat: 41.3851 },
  { name: '罗马', lng: 12.4964, lat: 41.9028 },
  { name: '米兰', lng: 9.1900, lat: 45.4642 },
  { name: '阿姆斯特丹', lng: 4.9041, lat: 52.3676 },
  { name: '布鲁塞尔', lng: 4.3517, lat: 50.8503 },
  { name: '维也纳', lng: 16.3738, lat: 48.2082 },
  { name: '苏黎世', lng: 8.5417, lat: 47.3769 },
  { name: '斯德哥尔摩', lng: 18.0686, lat: 59.3293 },
  { name: '奥斯陆', lng: 10.7522, lat: 59.9139 },
  { name: '哥本哈根', lng: 12.5683, lat: 55.6761 },
  { name: '赫尔辛基', lng: 24.9384, lat: 60.1699 },
  { name: '华沙', lng: 21.0122, lat: 52.2297 },
  { name: '布拉格', lng: 14.4378, lat: 50.0755 },
  { name: '布达佩斯', lng: 19.0402, lat: 47.4979 },
  { name: '基辅', lng: 30.5238, lat: 50.4501 },
  { name: '雅典', lng: 23.7275, lat: 37.9838 },
  { name: '里斯本', lng: -9.1393, lat: 38.7223 },
  { name: '都柏林', lng: -6.2603, lat: 53.3498 },
  { name: '莫斯科', lng: 37.6173, lat: 55.7558 },
  { name: '圣彼得堡', lng: 30.3351, lat: 59.9343 },
  { name: '新西伯利亚', lng: 82.9346, lat: 55.0084 },
  { name: '海参崴', lng: 131.8856, lat: 43.1155 },
  { name: '伊斯坦布尔', lng: 28.9784, lat: 41.0082 },
  { name: '迪拜', lng: 55.2708, lat: 25.2048 },
  { name: '利雅得', lng: 46.6753, lat: 24.7136 },
  { name: '德黑兰', lng: 51.3890, lat: 35.6892 },
  { name: '开罗', lng: 31.2357, lat: 30.0444 },
  { name: '拉各斯', lng: 3.3792, lat: 6.5244 },
  { name: '约翰内斯堡', lng: 28.0473, lat: -26.2041 },
  { name: '内罗毕', lng: 36.8219, lat: -1.2921 },
  { name: '亚的斯亚贝巴', lng: 38.7578, lat: 9.0054 },
  { name: '阿克拉', lng: -0.1870, lat: 5.6037 },
  { name: '达喀尔', lng: -17.4677, lat: 14.7167 },
  { name: '金沙萨', lng: 15.2663, lat: -4.4419 },
  { name: '罗安达', lng: 13.2344, lat: -8.8390 },
  { name: '喀土穆', lng: 32.5599, lat: 15.5007 },
  { name: '阿尔及尔', lng: 3.0588, lat: 36.7538 },
  { name: '突尼斯', lng: 10.1815, lat: 36.8065 },
  { name: '卡萨布兰卡', lng: -7.5898, lat: 33.5731 },
  { name: '悉尼', lng: 151.2093, lat: -33.8688 },
  { name: '墨尔本', lng: 144.9631, lat: -37.8136 },
  { name: '奥克兰', lng: 174.7633, lat: -36.8485 },
  { name: '布里斯班', lng: 153.0281, lat: -27.4698 },
  { name: '珀斯', lng: 115.8605, lat: -31.9505 },
];

// Combined corpus (the coordinate-sanity test iterates all centers).
export const CITY_CENTERS = [...CHINA_CENTERS, ...GLOBAL_CENTERS];

// Seeded xorshift32 — same generator as bench/datasets/generate.js.
function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

// Standard normal via Box-Muller, driven by a seeded rng.
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Wrap lng into [-180, 180) — a Gaussian offset can push a coastal
// center's longitude past the antimeridian; supercluster wraps lngs on
// query, so wrapped output is semantically the same point.
function wrapLng(lng) {
  return lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng;
}

// Spread in degrees — city-scale (~15 km), so each center's cluster stays
// visually distinct from its neighbors instead of blurring together.
// Exported for the tests (they pin the props-table alignment contract).
export const LNG_SPREAD = 0.15;
export const LAT_SPREAD = 0.1;

// Weighted center draw: each Chinese city counts ~5x a global one, so
// roughly two thirds of the points land on Chinese cities (readable
// against the Gaode basemap; the global majors keep worldwide coverage).
const CHINA_WEIGHT = 5;
const WEIGHTED = [
  ...CHINA_CENTERS.map((c) => ({ c, w: CHINA_WEIGHT })),
  ...GLOBAL_CENTERS.map((c) => ({ c, w: 1 })),
];
const TOTAL_WEIGHT = WEIGHTED.reduce((s, { w }) => s + w, 0);

function drawCenter(rng) {
  let t = rng() * TOTAL_WEIGHT;
  for (const { c, w } of WEIGHTED) {
    t -= w;
    if (t < 0) return c;
  }
  return WEIGHTED[WEIGHTED.length - 1].c;
}

// Great-circle distance (haversine) between two [lng, lat] pairs, in
// meters. Earth radius 6371 km.
function haversineMeters(lng1, lat1, lng2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/**
 * Generate n clustered Points as GeoJSON Features with per-point
 * properties {pid, city, value}, where value is the point's distance to
 * its seed center in meters (positive integer — the sum aggregate stays
 * meaningful). Seeded and reproducible.
 */
export function generateClusteredGeoJSON(n, seed) {
  const rng = createRng(seed);
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const center = drawCenter(rng);
    const lng = wrapLng(center.lng + gaussian(rng) * LNG_SPREAD);
    const lat = center.lat + gaussian(rng) * LAT_SPREAD;
    points[i] = {
      type: 'Feature',
      properties: {
        pid: i,
        city: center.name,
        value: Math.round(haversineMeters(lng, lat, center.lng, center.lat)),
      },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    };
  }
  return points;
}

/**
 * Generate n clustered Points as a flat Float64Array [lng, lat, ...] plus a
 * per-point props table indexed by the same order. Coordinate-identical to
 * generateClusteredGeoJSON for the same (n, seed): the rng draw order is
 * center -> gaussian lng -> gaussian lat in both (the value no longer
 * consumes the rng — it derives from the coordinates). The props table is
 * the join key for the load_coords path (Q8): the coords input carries no
 * properties, but every decoded point row keeps its feature_id (= input
 * index), so the consumer looks props[fid] up on click — geometry via
 * WASM, attributes self-held by the consumer.
 */
export function generateClusteredCoords(n, seed) {
  const rng = createRng(seed);
  const coords = new Float64Array(n * 2);
  const props = new Array(n);
  for (let i = 0; i < n; i++) {
    const center = drawCenter(rng);
    const lng = wrapLng(center.lng + gaussian(rng) * LNG_SPREAD);
    const lat = center.lat + gaussian(rng) * LAT_SPREAD;
    coords[i * 2] = lng;
    coords[i * 2 + 1] = lat;
    props[i] = {
      pid: i,
      city: center.name,
      value: Math.round(haversineMeters(lng, lat, center.lng, center.lat)),
    };
  }
  return { coords, props };
}
