// Soteria demo film (45 s). Every visual is a pure function of the time t, so
// a headless browser can render it frame by frame (window.__frame(t)).
// Open /video.html?t=12.3 to look at one moment, /video.html?play to preview.
//
//  0.0 –  6.7  hook + title over Berlin
//  6.7 – 24.2  Berlin Hbf, the train, the storm, damage, alerts, payouts
// 24.2 – 34.2  the real app, recorded live (frames from the screen recording)
// 34.2 – 38.9  payoff: €36,000 paid automatically
// 38.9 – 45.0  zoom out: live network across Europe, end card
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { MOCK_ASSETS } from '../data/mockFleetData';
import { measuredCorridor } from '../map/railGeometry';
import { addSoteriaLayers, buildDynamicData, setDynamicData } from '../map/soteriaLayers';
import { layoutTrain } from '../map/trainModel';
import type { FleetAsset } from '../types/fleet';
import EU from './europeRail.json';
import './video.css';

export const DURATION = 45;
const S = 3.7; // the story section starts 3.7 s later than in the 30 s cut (longer intro)

// ---------------------------------------------------------------- timeline
export const T = {
  hookIn: 0.3,
  hookOut: 4.45,
  heroIn: 4.4,
  heroOut: 6.7,
  pinIn: 2.75 + S,
  pinOut: 5.4 + S,
  hudIn: 4.5 + S,
  storm: 6.9 + S,
  lightning: [7.55 + S, 8.95 + S, 9.72 + S],
  fall: 9.72 + S,
  land: 10.42 + S,
  brake: 9.85 + S,
  stop: 10.85 + S,
  toasts: [10.95, 11.85, 13.05, 14.35, 15.75, 17.45, 18.85].map(x => x + S),
  hudOut: 20.45 + S,
  appIn: 24.2,
  appOut: 34.25,
  payIn: 34.2,
  payOut: 38.9,
  euIn: 38.4,
  endIn: 41.7,
  fadeOut: 44.35,
};

// ---------------------------------------------------------------- helpers
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const easeOut3 = (p: number) => 1 - (1 - p) ** 3;
const easeInOut3 = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const easeOutExpo = (p: number) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
const easeOutBack = (p: number) => { const c = 1.45; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; };
const fadeWindow = (t: number, a: number, b: number, inDur = 0.35, outDur = 0.35) =>
  Math.min(easeOut3(seg(t, a, a + inDur)), 1 - easeInOut3(seg(t, b - outDur, b)));

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const el = (tag: string, cls = '', html = '', parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};
const eur = (n: number) => '€' + Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------- scenario
const base = MOCK_ASSETS.find(a => a.id === 'asset-tr-1003')!;
const line = measuredCorridor(base.track!.corridorId)!;
const STOP = base.track!.headAlongM;
const OBST_AT = STOP + (base.track!.obstruction?.aheadM ?? 6);
const TUNNEL_END = 1101;
const B = line.bearingAt(1420);
const V = 11; // m/s before braking
const BRAKE_DIST = (V * (T.stop - T.brake)) / 2;
const layout = layoutTrain(base);

function head(t: number) {
  if (t < T.brake) return Math.max(TUNNEL_END + 240, STOP - BRAKE_DIST - V * (T.brake - t));
  if (t < T.stop) {
    const tau = t - T.brake;
    const a = V / (T.stop - T.brake);
    return STOP - BRAKE_DIST + V * tau - 0.5 * a * tau * tau;
  }
  return STOP;
}
const speedKmh = (t: number) => (t < T.brake ? V : t < T.stop ? V * (1 - (t - T.brake) / (T.stop - T.brake)) : 0) * 3.6;

function assetAt(t: number): FleetAsset {
  const hit = t >= T.land;
  return {
    ...base,
    status: hit ? 'offline' : 'online',
    speedKmh: 0,
    wagons: base.wagons!.map(w => ({ ...w, damaged: hit && w.damaged })),
    track: {
      ...base.track!,
      headAlongM: head(t),
      trackBlocked: hit,
      obstruction: hit ? base.track!.obstruction : undefined,
    },
  };
}

const carAlong = (t: number, id: string) => {
  const car = id === 'LOCO' ? layout.cars[0] : layout.cars.find(c => c.wagon?.id === id)!;
  return head(t) - (car.from + car.to) / 2;
};

// ---------------------------------------------------------------- 3D extras: catenary, headlight, the falling tree
type Part = Feature<Polygon>;
const part = (ring: [number, number][], baseH: number, top: number, color: string): Part => ({
  type: 'Feature',
  properties: { assetId: 'video', base: Math.max(0, baseH), top: Math.max(0.05, top), color },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const decal = (ring: [number, number][], color: string, opacity: number): Part => ({
  type: 'Feature',
  properties: { assetId: 'video', color, opacity },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const box = (d0: number, d1: number, y0: number, y1: number, b: number, h: number, c: string) => part(line.ribbon(d0, d1, y0, y1, 0.5), b, h, c);

function blobRing(d: number, y: number, radii: number[], rot: number): [number, number][] {
  const { p, dir } = line.frameAt(d);
  const n = [dir[1], -dir[0]];
  const ring = radii.map((r, i) => {
    const a = rot + (i / radii.length) * Math.PI * 2;
    const [u, v] = [Math.cos(a) * r, y + Math.sin(a) * r];
    return line.toLngLat([p[0] + dir[0] * u + n[0] * v, p[1] + dir[1] * u + n[1] * v]);
  });
  ring.push(ring[0]);
  return ring;
}

const trunkAt = (y: number) => OBST_AT + 3 + (y + 9) * 0.12;
const MAST_Y = -4.6;
const BROKEN_MAST = OBST_AT + 11.9;
const masts = Array.from({ length: 10 }, (_, i) => BROKEN_MAST - 55 * (7 - i));

function extras(t: number): { parts: Part[]; decals: Part[] } {
  const parts: Part[] = [];
  const decals: Part[] = [];
  const hit = t >= T.land;
  for (const m of masts) {
    if (m < TUNNEL_END + 20) continue;
    if (hit && Math.abs(m - BROKEN_MAST) < 1) continue;
    parts.push(box(m - 0.18, m + 0.18, MAST_Y - 0.18, MAST_Y + 0.18, 0, 7.3, '#8f97a3'));
    parts.push(box(m - 0.06, m + 0.06, MAST_Y, 0.6, 6.55, 6.7, '#b8bec8'));
    parts.push(box(m - 0.05, m + 0.05, -0.05, 0.05, 5.5, 6.6, '#9aa1ab'));
  }
  const wire = (from: number, to: number) => {
    if (to - from < 1) return;
    parts.push(box(from, to, -0.04, 0.04, 5.48, 5.56, '#d9b25a'));
    parts.push(box(from, to, -0.04, 0.04, 6.62, 6.68, '#9aa1ab'));
  };
  const w0 = TUNNEL_END + 20, w1 = BROKEN_MAST + 160;
  if (hit) { wire(w0, OBST_AT - 22); wire(BROKEN_MAST + 30, w1); } else wire(w0, w1);

  // headlight beam on the ballast ahead of the locomotive
  const h = head(t);
  const beam = t < T.land ? 1 : 0.55;
  for (const [len, w, o] of [[46, 5.5, 0.1], [30, 3.8, 0.13], [16, 2.4, 0.17]] as const) {
    const ring: [number, number][] = [];
    const steps = 8;
    for (let s = 0; s <= steps; s++) {
      const d = h + 0.5 + (len * s) / steps;
      const half = 1.2 + ((w - 1.2) * s) / steps;
      const { p, dir } = line.frameAt(d);
      ring.push(line.toLngLat([p[0] + dir[1] * -half, p[1] - dir[0] * -half]));
    }
    for (let s = steps; s >= 0; s--) {
      const d = h + 0.5 + (len * s) / steps;
      const half = 1.2 + ((w - 1.2) * s) / steps;
      const { p, dir } = line.frameAt(d);
      ring.push(line.toLngLat([p[0] + dir[1] * half, p[1] - dir[0] * half]));
    }
    ring.push(ring[0]);
    decals.push(decal(ring, '#fff2c4', o * beam));
  }

  if (hit) return { parts, decals };
  const p = seg(t, T.fall, T.land);
  const theta = (Math.PI / 2) * p * p;
  const rootY = -9;
  const L = 16;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const [ra, rb] = [(i / N) * L, ((i + 1) / N) * L];
    const rad = lerp(0.48, 0.24, i / N);
    const ya = rootY + ra * Math.sin(theta), yb = rootY + rb * Math.sin(theta);
    const za = ra * Math.cos(theta), zb = rb * Math.cos(theta);
    const dc = trunkAt((ya + yb) / 2);
    const wy = rad * Math.cos(theta), wz = rad * Math.sin(theta);
    parts.push(box(dc - rad, dc + rad, Math.min(ya, yb) - wy, Math.max(ya, yb) + wy, Math.min(za, zb) - wz, Math.max(za, zb) + wz, i % 2 ? '#6e5240' : '#5e4433'));
  }
  const crown: [number, number, number, number, string][] = [
    [11.5, -1.2, 0.4, 3.0, '#2c5a25'], [12.5, 1.6, -1.2, 3.2, '#305f28'], [14.2, -2.4, 1.5, 3.4, '#36692d'],
    [15.0, 2.2, 1.0, 3.6, '#3a7030'], [16.6, 0, -1.8, 4.0, '#3f7834'], [17.4, -2.8, -0.6, 3.0, '#46803a'],
    [18.2, 2.6, 0.8, 3.2, '#447e38'], [19.6, -0.6, 1.4, 3.4, '#4d8a40'], [20.8, 1.4, -1.0, 2.6, '#559447'],
    [21.6, -1.6, 0.2, 2.2, '#5a994a'], [13.2, 0.4, 2.4, 2.4, '#33652b'], [16.0, -0.8, 0.2, 4.2, '#3b7231'],
  ];
  crown.forEach(([r, side, dOff, size, color], k) => {
    const y = rootY + r * Math.sin(theta) + side * Math.cos(theta);
    const z = r * Math.cos(theta) - side * Math.sin(theta);
    const d = trunkAt(Math.min(y, 12)) + dOff;
    const radii = [1, 0.82, 1.1, 0.88, 1.04, 0.8, 0.98, 0.9, 1.06, 0.86].map(f => f * size);
    const half = size * lerp(0.85, 0.5, Math.sin(theta));
    parts.push(part(blobRing(d, y, radii, k * 0.9), z - half, z + half, color));
  });
  return { parts, decals };
}

// ---------------------------------------------------------------- Europe: real rail network (Natural Earth), simulated fleet
const EU_PATHS = (EU as { paths: [number, number][][]; km: number[] }).paths;
const EU_KM = (EU as { km: number[] }).km;
const EU_CUM = EU_PATHS.map(p => {
  const c = [0];
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]];
    const dx = (b[0] - a[0]) * 111 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), dy = (b[1] - a[1]) * 111;
    c.push(c[i - 1] + Math.hypot(dx, dy));
  }
  return c;
});
const euRng = mulberry32(2026);
const totalKm = EU_KM.reduce((a, b) => a + b, 0);
const N_TRAINS = 1400;
const TRAINS = Array.from({ length: N_TRAINS }, (_, i) => {
  let r = euRng() * totalKm, k = 0;
  while (r > EU_KM[k] && k < EU_KM.length - 1) r -= EU_KM[k++];
  const status = i < 3 ? 'alert' : euRng() < 0.05 ? 'warn' : 'ok';
  return { path: k, s0: euRng() * 2 * EU_KM[k], v: (14 + euRng() * 22) * (euRng() < 0.5 ? 1 : -1), status };
});
function pointOnPath(k: number, s: number): [number, number] {
  const L = EU_CUM[k][EU_CUM[k].length - 1];
  let d = ((s % (2 * L)) + 2 * L) % (2 * L);
  if (d > L) d = 2 * L - d;
  const c = EU_CUM[k], p = EU_PATHS[k];
  let lo = 1, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < d) lo = m + 1; else hi = m; }
  const f = (d - c[lo - 1]) / ((c[lo] - c[lo - 1]) || 1);
  return [lerp(p[lo - 1][0], p[lo][0], f), lerp(p[lo - 1][1], p[lo][1], f)];
}
const BERLIN: [number, number] = [13.3634, 52.5319];
function euTrains(t: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = TRAINS.map((tr, i) => ({
    type: 'Feature',
    properties: { status: i === 0 ? 'alert' : tr.status },
    geometry: { type: 'Point', coordinates: i === 0 ? BERLIN : pointOnPath(tr.path, tr.s0 + tr.v * t) },
  }));
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- camera
interface Key { t: number; c: [number, number]; zoom: number; pitch: number; bear: number }
const along = (a: number, off = 0): [number, number] => {
  const { p, dir } = line.frameAt(a);
  return line.toLngLat([p[0] + dir[1] * off, p[1] - dir[0] * off]);
};
const K = (t: number, a: number, zoom: number, pitch: number, bear: number, off = 0): Key => ({ t, c: along(a, off), zoom, pitch, bear });
const EU_BEAR = (() => { const prev = -200; let target = -B; while (target - prev > 180) target -= 360; while (target - prev < -180) target += 360; return target; })();
const KEYS: Key[] = [
  K(0.0, -40, 14.4, 40, 52),
  K(2.1, 120, 14.7, 44, 40),
  K(3.7, 300, 15.2, 48, 28),
  K(6.7, 585, 16.35, 60, -6),
  K(8.5, 900, 17.0, 63, -40),
  K(10.3, 1345, 18.2, 66, -70),
  K(12.5, 1420, 18.6, 64, -92),
  K(14.0, STOP + 4, 19.25, 64, -122),
  K(15.5, STOP + 1, 19.5, 63, -136),
  K(17.9, STOP - 24, 19.2, 61, -150),
  K(20.9, STOP - 55, 19.0, 60, -163),
  K(24.1, STOP - 92, 18.7, 60, -174),
  K(34.3, STOP - 150, 17.2, 56, -200),
  { t: 36.4, c: along(STOP - 200), zoom: 13.6, pitch: 50, bear: -200 + (EU_BEAR + 200) * 0.25 },
  { t: 40.4, c: [11.2, 50.6], zoom: 4.55, pitch: 28, bear: EU_BEAR },
  { t: 45.0, c: [10.6, 50.2], zoom: 4.3, pitch: 34, bear: EU_BEAR + 6 },
];
function hermiteBy(t: number, get: (k: Key) => number) {
  const k = KEYS;
  if (t <= k[0].t) return get(k[0]);
  if (t >= k[k.length - 1].t) return get(k[k.length - 1]);
  let i = 0;
  while (k[i + 1].t < t) i++;
  const [a, b] = [k[i], k[i + 1]];
  const h = b.t - a.t;
  const slope = (j: number) => {
    if (j <= 0 || j >= k.length - 1) return 0;
    const s0 = (get(k[j]) - get(k[j - 1])) / (k[j].t - k[j - 1].t);
    const s1 = (get(k[j + 1]) - get(k[j])) / (k[j + 1].t - k[j].t);
    return s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  };
  const m0 = slope(i) * h, m1 = slope(i + 1) * h;
  const s = (t - a.t) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * get(a) + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * get(b) + (s3 - s2) * m1;
}
function cameraAt(t: number) {
  const zoom = hermiteBy(t, k => k.zoom);
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].t < t) i++;
  const [a, b] = [KEYS[i], KEYS[i + 1]];
  let center: [number, number];
  if (Math.abs(a.zoom - b.zoom) > 3 && t > a.t && t < b.t) {
    // big zoom change: move the centre in step with the visible area, like flyTo
    const w = (z: number) => 2 ** -z;
    const u = clamp((w(zoom) - w(a.zoom)) / (w(b.zoom) - w(a.zoom)));
    center = [lerp(a.c[0], b.c[0], u), lerp(a.c[1], b.c[1], u)];
  } else {
    center = [hermiteBy(t, k => k.c[0]), hermiteBy(t, k => k.c[1])];
  }
  return { center, zoom, pitch: hermiteBy(t, k => k.pitch), bearing: B + hermiteBy(t, k => k.bear) };
}

function shake(t: number): [number, number] {
  const dt = t - T.land;
  if (dt < 0 || dt > 1.6) return [0, 0];
  const a = 22 * Math.exp(-dt * 3.4);
  return [a * (Math.sin(dt * 71) * 0.6 + Math.sin(dt * 43 + 1) * 0.4), a * (Math.cos(dt * 63) * 0.6 + Math.sin(dt * 37 + 2) * 0.4)];
}

const lightning = (t: number) => {
  let f = 0;
  for (const s of T.lightning) {
    const d = t - s;
    if (d < 0 || d > 0.9) continue;
    f = Math.max(f, Math.exp(-d * 16) + (d > 0.13 ? 0.75 * Math.exp(-(d - 0.13) * 11) : 0));
  }
  return clamp(f);
};

// ---------------------------------------------------------------- map
const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;
const Q = new URLSearchParams(location.search);
mapboxgl.accessToken = TOKEN;
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  config: {
    basemap: {
      lightPreset: Q.get('light') ?? 'dusk',
      show3dObjects: true,
      show3dBuildings: true,
      show3dFacades: true,
      show3dLandmarks: true,
      show3dTrees: true,
      showTransitLabels: true,
      showPointOfInterestLabels: false,
      showRoadLabels: false,
    },
  },
  ...cameraAt(0),
  antialias: true,
  maxPitch: 85,
  projection: 'globe',
  fadeDuration: 0,
  interactive: false,
  preserveDrawingBuffer: true,
  attributionControl: false,
} as mapboxgl.MapOptions);

const mapReady = new Promise<void>(resolve => {
  map.on('load', () => {
    map.addSource('sat', { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 });
    map.addLayer({
      id: 'satellite-ground', type: 'raster', source: 'sat', slot: 'middle',
      paint: { 'raster-saturation': -0.2, 'raster-contrast': 0.1, 'raster-emissive-strength': 0.32 },
    } as mapboxgl.LayerSpecification);
    map.addSource('soteria-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
    map.setTerrain({ source: 'soteria-dem', exaggeration: 1 });
    addSoteriaLayers(map, { standard: true, font: ['DIN Pro Medium', 'Arial Unicode MS Regular'] });
    map.setLayoutProperty('train-labels', 'visibility', 'none');

    // Europe: rail network and the live fleet on it
    map.addSource('eu-rail', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: EU_PATHS } }] },
    });
    map.addSource('eu-trains', { type: 'geojson', data: euTrains(0) });
    const zOp = (v: number): mapboxgl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 6.5, v, 9, 0];
    map.addLayer({ id: 'eu-rail-glow', type: 'line', source: 'eu-rail', slot: 'top', maxzoom: 9.5,
      paint: { 'line-color': '#5b8cff', 'line-width': 2.6, 'line-blur': 2.5, 'line-opacity': zOp(0.22), 'line-emissive-strength': 1 } } as mapboxgl.LayerSpecification);
    map.addLayer({ id: 'eu-rail-core', type: 'line', source: 'eu-rail', slot: 'top', maxzoom: 9.5,
      paint: { 'line-color': '#9db8ff', 'line-width': 0.7, 'line-opacity': zOp(0.42), 'line-emissive-strength': 1 } } as mapboxgl.LayerSpecification);
    const color: mapboxgl.ExpressionSpecification = ['match', ['get', 'status'], 'alert', '#ff4d4d', 'warn', '#fbbf24', '#7dd3fc'];
    map.addLayer({ id: 'eu-train-glow', type: 'circle', source: 'eu-trains', slot: 'top', maxzoom: 9.5,
      paint: { 'circle-color': color, 'circle-radius': ['match', ['get', 'status'], 'alert', 16, 'warn', 7, 5.5], 'circle-blur': 1, 'circle-opacity': zOp(0.55), 'circle-emissive-strength': 1 } } as mapboxgl.LayerSpecification);
    map.addLayer({ id: 'eu-train-dot', type: 'circle', source: 'eu-trains', slot: 'top', maxzoom: 9.5,
      paint: { 'circle-color': ['match', ['get', 'status'], 'alert', '#ffd0d0', 'warn', '#fde68a', '#e0f2fe'], 'circle-radius': ['match', ['get', 'status'], 'alert', 3.6, 2], 'circle-opacity': zOp(1), 'circle-emissive-strength': 1 } } as mapboxgl.LayerSpecification);
    resolve();
  });
});

function updateMap(t: number) {
  map.jumpTo(cameraAt(t));
  const asset = assetAt(t);
  const data = buildDynamicData([asset], a => a.track!.headAlongM);
  const h = head(t);
  data.trains.features = data.trains.features.filter(f => {
    const car = layout.cars[f.properties!.car as number];
    return h - (car.from + car.to) / 2 > TUNNEL_END + 4;
  });
  const ex = extras(t);
  data.obstructions.features.push(...ex.parts);
  data.decals.features.push(...ex.decals);
  setDynamicData(map, data);
  if (t > T.payIn) (map.getSource('eu-trains') as mapboxgl.GeoJSONSource).setData(euTrains(t));
  const pulse = 0.5 + 0.5 * Math.sin(t * 6.5);
  if (map.getLayer('train-damage-halo')) map.setPaintProperty('train-damage-halo', 'circle-opacity', 0.25 + 0.55 * pulse);
  if (map.getLayer('track-blocked-glow')) map.setPaintProperty('track-blocked-glow', 'line-opacity', 0.25 + 0.6 * pulse);
  if (map.getLayer('route-remaining-glow')) map.setPaintProperty('route-remaining-glow', 'line-opacity', 0.55 + 0.25 * Math.sin(t * 2.2));
  map.setPaintProperty('eu-train-glow', 'circle-radius', ['match', ['get', 'status'], 'alert', 12 + 9 * pulse, 'warn', 7, 5.5]);
}

function waitIdle(): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    map.once('idle', finish);
    map.triggerRepaint();
    setTimeout(finish, 20000);
  });
}

// ---------------------------------------------------------------- icons
const ICON = {
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  thermo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12"/><path d="M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/></svg>',
};
const SOTERIA_MARK = `<svg viewBox="0 0 48 48" fill="none"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b4a7ff"/></linearGradient></defs><path d="M24 3 6 10v12c0 11.5 7.6 19.7 18 23 10.4-3.3 18-11.5 18-23V10L24 3Z" stroke="url(#sg)" stroke-width="3" stroke-linejoin="round"/><path d="M16 28h16M18 20h12M24 14v20" stroke="url(#sg)" stroke-width="3" stroke-linecap="round"/></svg>`;
// a generic ledger glyph: three linked blocks
const LEDGER_MARK = `<svg viewBox="0 0 32 32" fill="none" stroke="#a99bff" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="11" width="8" height="10" rx="2"/><rect x="12" y="11" width="8" height="10" rx="2" fill="rgba(131,110,249,.35)"/><rect x="21" y="11" width="8" height="10" rx="2"/><path d="M11 16h1M20 16h1" stroke-linecap="round"/></svg>`;

// ---------------------------------------------------------------- UI build
const ui = document.getElementById('ui')!;
const fx = document.getElementById('fx')!;
const mapWrap = document.getElementById('map-wrap')!;

const rain = el('canvas', '', '', fx) as HTMLCanvasElement;
rain.width = 1920; rain.height = 1080;
const rctx = rain.getContext('2d')!;
const rainRng = mulberry32(7);
const DROPS = Array.from({ length: 1100 }, () => ({
  x: rainRng() * 2300 - 200, y: rainRng() * 1300, v: 1700 + rainRng() * 1300, len: 22 + rainRng() * 46, a: 0.12 + rainRng() * 0.3, w: rainRng() < 0.15 ? 2 : 1,
}));

const sparksLayer = el('div', 'layer', '', ui);
const chipLayer = el('div', 'layer', '', ui);
const packetLayer = el('div', 'layer', '', ui);
const floatLayer = el('div', 'layer', '', ui);

const vignette = el('div', 'abs vignette', '', ui);
const redwash = el('div', 'abs redwash', '', ui);

const hbfPin = el('div', 'abs', `<div class="glass" style="padding:10px 16px;border-radius:12px;white-space:nowrap;text-align:center">
  <div style="font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:#a1a1aa">ORIGIN · TR-1003</div>
  <div style="font-weight:800;font-size:22px;margin-top:2px">Berlin Hauptbahnhof</div></div>
  <div style="width:2px;height:70px;margin:0 auto;background:linear-gradient(#fff,rgba(255,255,255,0))"></div>
  <div style="width:14px;height:14px;margin:-4px auto 0;border-radius:50%;background:#fff;box-shadow:0 0 22px #fff"></div>`, ui);
hbfPin.style.left = '0'; hbfPin.style.top = '0';

const brand = el('div', 'abs brand', `<div class="brand-mark">${SOTERIA_MARK}</div>
  <div><div class="brand-name">SOTERIA</div><div class="brand-sub">REAL-TIME CARGO PROTECTION</div></div>
  <div class="live-pill glass"><span class="live-dot"></span>LIVE</div>`, ui);
const brandSub = brand.querySelector('.brand-sub') as HTMLElement;
const trip = el('div', 'abs trip glass', `
  <div><div class="k">Train</div><div class="v">TR-1003 · Freight train</div></div><div class="sep"></div>
  <div><div class="k">Route</div><div class="v">Berlin Hbf → Hamburg Hbf</div></div><div class="sep"></div>
  <div><div class="k">Speed</div><div class="v mono" data-speed>40 km/h</div></div><div class="sep"></div>
  <div><div class="k">Time</div><div class="v mono"><span data-clock>17:59:50</span><span class="lapse" data-lapse></span></div></div>`, ui);
const speedEl = trip.querySelector('[data-speed]') as HTMLElement;
const clockEl = trip.querySelector('[data-clock]') as HTMLElement;
const lapseEl = trip.querySelector('[data-lapse]') as HTMLElement;

const ledger = el('div', 'abs monad glass', `
  <div class="monad-head"><div class="monad-logo">${LEDGER_MARK}</div><div><div class="monad-title">Settlement ledger</div><div class="monad-net">SMART CONTRACT · TAMPER-PROOF</div></div>
  <div class="monad-live"><i></i>STREAMING</div></div>
  <div class="monad-grid">
    <div class="stat"><div class="k">Block</div><div class="v" data-block></div></div>
    <div class="stat"><div class="k">Readings/s</div><div class="v" data-rps></div></div>
    <div class="stat"><div class="k">Final after</div><div class="v">0.6<small>s</small></div></div>
  </div>
  <div class="bars" data-bars></div>
  <div class="bars-cap"><span>SENSOR READINGS RECORDED</span><span data-total></span></div>`, ui);
const blockEl = ledger.querySelector('[data-block]') as HTMLElement;
const rpsEl = ledger.querySelector('[data-rps]') as HTMLElement;
const totalEl = ledger.querySelector('[data-total]') as HTMLElement;
const barsEl = ledger.querySelector('[data-bars]') as HTMLElement;
const BAR_N = 34;
const bars = Array.from({ length: BAR_N }, () => el('b', '', '', barsEl));

const sensor = el('div', 'abs sensor glass', `
  <div class="sensor-head"><span class="badge">W02 · PHARMA</span><span class="name">Reefer · insulin</span><span class="rate" data-rate>4 Hz · heartbeat 10 s</span></div>
  <div class="sensor-temp"><span class="big" data-temp>+5.0 °C</span><span class="lim">limit +2 … +8 °C</span></div>
  <svg width="430" height="120" viewBox="0 0 430 120" data-chart>
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444" stop-opacity=".45"/><stop offset="1" stop-color="#ef4444" stop-opacity="0"/></linearGradient></defs>
    <rect x="0" y="0" width="430" height="34" fill="rgba(239,68,68,.10)"/>
    <line x1="0" x2="430" y1="34" y2="34" stroke="#ef4444" stroke-dasharray="5 5" stroke-width="1.5"/>
    <text x="6" y="26" text-anchor="start" fill="#f87171" font-family="JetBrains Mono" font-size="11" font-weight="700">+8 °C LIMIT</text>
    <path data-area fill="url(#tg)"/><path data-path fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>
    <circle data-head r="5" fill="#fff"/>
  </svg>
  <div class="accrue"><div><div class="k">Compensation accruing</div><div class="cap">€400 / s out of range · cap €12,000</div></div><div class="v" data-acc>€0</div></div>`, ui);
const tempEl = sensor.querySelector('[data-temp]') as HTMLElement;
const rateEl = sensor.querySelector('[data-rate]') as HTMLElement;
const accEl = sensor.querySelector('[data-acc]') as HTMLElement;
const pathEl = sensor.querySelector('[data-path]') as SVGPathElement;
const areaEl = sensor.querySelector('[data-area]') as SVGPathElement;
const headDot = sensor.querySelector('[data-head]') as SVGCircleElement;
const accrueBox = sensor.querySelector('.accrue') as HTMLElement;

interface ToastDef { at: number; tone: string; icon: string; title: string; sub: string; block: number }
const TOASTS: ToastDef[] = [
  { at: T.toasts[0], tone: 'alert', icon: ICON.alert, title: 'Safety alert · W05 hazmat tank', sub: 'Impact 4.70 g · timestamped as proof of notification', block: 0 },
  { at: T.toasts[1], tone: 'alert', icon: ICON.alert, title: 'Safety alert · W05 tank pressure', sub: 'Pressure drop 4.80 → 3.10 bar · leak not ruled out', block: 0 },
  { at: T.toasts[2], tone: 'alert', icon: ICON.thermo, title: 'Cold chain broken · W02 pharma', sub: '+8.3 °C, above the +8 °C limit · €400/s accruing', block: 0 },
  { at: T.toasts[3], tone: 'delay', icon: ICON.clock, title: '€9,000 delay penalty accrues', sub: 'Standstill beyond slack · delivery slot lost', block: 0 },
  { at: T.toasts[4], tone: 'anchor', icon: ICON.shield, title: 'Soteria decision · INC-1003', sub: 'Stop train · notify authority · two human keys', block: 0 },
  { at: T.toasts[5], tone: 'payout', icon: ICON.euro, title: '€12,000 paid to Chemiewerk', sub: 'W02 cold chain out of range · paid automatically', block: 0 },
  { at: T.toasts[6], tone: 'payout', icon: ICON.euro, title: '€24,000 paid to Chemiewerk', sub: 'W03 damage assessed · paid from the liability pool', block: 0 },
];
const toastBox = el('div', 'abs toasts', '', ui);
const BLOCK0 = 24_118_406;
const blockAt = (t: number) => BLOCK0 + Math.floor(t / 0.4);
const toastEls = TOASTS.map(d => {
  d.block = blockAt(d.at - 0.62);
  return el('div', `toast tone-${d.tone}`, `<div class="ic">${d.icon}</div><div style="min-width:0"><div class="t">${d.title}</div><div class="s">${d.sub}</div>
    <div class="m">block #${d.block.toLocaleString('en-US')} · <em>final after 0.6${(d.block % 7) + 1} s</em> · 0x${(d.block * 2654435761 >>> 0).toString(16).padStart(8, '0').slice(0, 6)}…</div></div>`, toastBox);
});

interface ChipDef { id: string; tag: string; lift: number }
const CHIPS: ChipDef[] = [
  { id: 'LOCO', tag: 'LOCO · SPEED', lift: 0 },
  { id: 'W02', tag: 'W02 · PHARMA', lift: 46 },
  { id: 'W05', tag: 'W05 · HAZMAT', lift: 0 },
  { id: 'W07', tag: 'W07 · FROZEN', lift: 46 },
];
const chipEls = CHIPS.map(c => {
  const e = el('div', 'chip', `<span class="dot"></span><div><div class="tag">${c.tag}</div><div class="val">–</div></div>`, chipLayer);
  return { def: c, root: e, val: e.querySelector('.val') as HTMLElement, dot: e.querySelector('.dot') as HTMLElement };
});
const packets = Array.from({ length: 24 }, () => el('div', 'packet', '', packetLayer));
const sparks = Array.from({ length: 46 }, () => el('div', 'spark', '', sparksLayer));
const sparkRng = mulberry32(42);
const SPARKS = sparks.map(() => ({ vx: (sparkRng() - 0.5) * 900, vy: -200 - sparkRng() * 700, life: 0.5 + sparkRng() * 0.7, delay: sparkRng() * 0.25 }));

interface FloatDef { at: number; id: string; cls: string; text: string }
const FLOATS: FloatDef[] = [
  { at: T.toasts[0] - 0.05, id: 'W05', cls: 'alert', text: '⚠ 4.70 g' },
  { at: T.toasts[2] - 0.05, id: 'W02', cls: 'alert', text: '+8.3 °C' },
  { at: T.toasts[5] - 0.05, id: 'W02', cls: 'money', text: '+€12,000' },
  { at: T.toasts[6] - 0.05, id: 'W03', cls: 'money', text: '+€24,000' },
];
const floatEls = FLOATS.map(f => el('div', `float ${f.cls}`, f.text, floatLayer));

interface Cap { a: number; b: number; kicker: string; words: [string, string?][] }
const CAPS: Cap[] = [
  { a: 8.5, b: 11.35, kicker: 'Live · TR-1003 leaves Berlin Hbf', words: [['Sensors'], ['report'], ['every'], ['wagon,'], ['4×', 'hl-purple'], ['a', 'hl-purple'], ['second.', 'hl-purple']] },
  { a: 11.55, b: 13.5, kicker: '18:00 · Storm front over Berlin', words: [['Then'], ['the'], ['storm'], ['hits.', 'hl-red']] },
  { a: 15.25, b: 18.75, kicker: 'Impact · 3 wagons damaged', words: [['Damage'], ['detected'], ['in', 'hl-red'], ['under', 'hl-red'], ['a', 'hl-red'], ['second.', 'hl-red']] },
  { a: 19.1, b: 23.95, kicker: 'Smart contract · no claim form', words: [['Compensation'], ['pays'], ['out', 'hl-green'], ['automatically.', 'hl-green']] },
];
const capEls = CAPS.map(c => {
  const root = el('div', 'abs caption', `<div class="kicker"><i></i>${c.kicker}</div><div class="line"></div>`, ui);
  const lineEl = root.querySelector('.line') as HTMLElement;
  const words = c.words.map(([w, cls]) => el('span', `word ${cls ?? ''}`, w, lineEl));
  return { def: c, root, kicker: root.querySelector('.kicker') as HTMLElement, words };
});

const dimEl = el('div', 'abs dim', '', ui);

// hook
const hook = el('div', 'abs hook', `<div class="hook-k">Rail freight today</div>
  <div class="hook-l"><span>Cargo damaged.</span> <span class="dimw">Months of claims,</span> <span class="dimw">reports and disputes.</span></div>`, ui);
const hookK = hook.querySelector('.hook-k') as HTMLElement;
const hookSpans = Array.from(hook.querySelectorAll('.hook-l span')) as HTMLElement[];

// title
const hero = el('div', 'abs hero', `<div class="mark">${SOTERIA_MARK}</div><div class="name">SOTERIA</div>
  <div class="tag">Live monitoring for rail freight. <b>Automatic compensation</b> when cargo is damaged.</div>`, ui);
const heroMark = hero.querySelector('.mark') as HTMLElement;
const heroName = hero.querySelector('.name') as HTMLElement;
const heroTag = hero.querySelector('.tag') as HTMLElement;

// ---------------------------------------------------------------- the real app (screen recording)
const APP = el('div', 'abs appstage', `
  <div class="app-head"><div class="app-k">The real product · recorded live</div><div class="app-title"></div></div>
  <div class="appwin"><div class="appbar"><i></i><i></i><i></i><span>Soteria · Operations Console</span></div>
    <div class="appview"><img class="appimg" alt=""><img class="appimg b" alt=""></div></div>`, ui);
const appWin = APP.querySelector('.appwin') as HTMLElement;
const appTitle = APP.querySelector('.app-title') as HTMLElement;
const appK = APP.querySelector('.app-k') as HTMLElement;
const appImgs = Array.from(APP.querySelectorAll('.appimg')) as HTMLImageElement[];
const REC_URL = Q.get('rec') ?? 'http://localhost:5300/';
interface Focus { s: number; x: number; y: number }
interface Clip { a: number; b: number; rec: number; speed: number; title: string; f0: Focus; f1: Focus }
const REC = (window as unknown as { __REC?: Record<string, number> }).__REC;
let CLIPS: Clip[] = [];
function buildClips(m: Record<string, number>) {
  const W = { s: 1, x: 960, y: 540 };
  CLIPS = [
    { a: T.appIn, b: 28.0, rec: m.s3 + 4.0, speed: 1.9, title: '<b>01</b> Live map · the incident as it happens', f0: W, f1: W },
    { a: 28.0, b: 30.8, rec: m.fleet + 3.6, speed: 1.5, title: '<b>02</b> Fleet · every sensor, live', f0: W, f1: W },
    { a: 30.8, b: T.appOut, rec: m['analytics-2'] + 0.6, speed: 1.2, title: '<b>03</b> Analytics · €36,000 paid automatically', f0: W, f1: W },
  ];
}
if (REC) buildClips(REC);
function clipAt(t: number) { return CLIPS.find(c => t >= c.a && t < c.b) ?? (t >= T.appOut - 0.01 ? CLIPS[CLIPS.length - 1] : CLIPS[0]); }
function recFrame(c: Clip, t: number) { return Math.round((c.rec + (t - c.a) * c.speed) * 30); }
const recSrc = (n: number) => `${REC_URL}${String(Math.max(0, n)).padStart(5, '0')}.jpg`;
function placeImg(img: HTMLImageElement, f: Focus) {
  const k = 1440 / 1920 * f.s;
  let tx = 720 - f.x * k, ty = 405 - f.y * k;
  tx = clamp(tx, 1440 - 1920 * k, 0); ty = clamp(ty, 810 - 1080 * k, 0);
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
}
async function loadImg(img: HTMLImageElement, src: string) {
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.src = src;
  try { await img.decode(); } catch { /* keep the previous frame */ }
}

// payoff
const payoff = el('div', 'abs payoff', `<div class="k">Paid to the cargo owner · automatically</div><div class="amount" data-amt>€0</div>
  <div class="sub">Settled on a tamper-proof ledger in 0.6 s. No claim form. No dispute.</div>
  <div class="compare">
    <div class="cmp old glass"><div class="k">Today</div><div class="v">Months</div><div class="d">Report → assessment → dispute → payout</div></div>
    <div class="cmp new glass"><div class="k">With Soteria</div><div class="v">0.6 s</div><div class="d">The sensor reading is the claim</div></div>
  </div>
  <div class="facts">
    <div class="fact glass"><b>4 Hz</b> sensors per wagon</div>
    <div class="fact glass"><b>~€0.0001</b> per reading</div>
    <div class="fact glass"><b>Every</b> decision auditable</div>
  </div>`, ui);
const amtEl = payoff.querySelector('[data-amt]') as HTMLElement;
const payK = payoff.querySelector('.k') as HTMLElement;
const paySub = payoff.querySelector('.sub') as HTMLElement;
const cmpEls = Array.from(payoff.querySelectorAll('.cmp')) as HTMLElement[];
const factEls = Array.from(payoff.querySelectorAll('.fact')) as HTMLElement[];

// Europe live network
const euPanel = el('div', 'abs eu glass', `<div class="eu-head"><span class="live-dot"></span>LIVE NETWORK · EUROPE</div>
  <div class="eu-grid">
    <div><div class="k">Trains monitored</div><div class="v" data-eu="trains">0</div></div>
    <div><div class="k">Wagons with sensors</div><div class="v" data-eu="wagons">0</div></div>
    <div><div class="k">Readings / s</div><div class="v" data-eu="rps">0</div></div>
    <div><div class="k">Open incidents</div><div class="v red" data-eu="inc">0</div></div>
  </div>
  <div class="eu-paid"><span>Paid automatically today</span><b data-eu="paid">€0</b></div>`, ui);
const euVals = Object.fromEntries(Array.from(euPanel.querySelectorAll('[data-eu]')).map(e => [(e as HTMLElement).dataset.eu!, e as HTMLElement]));
const euLabel = el('div', 'abs eu-label', `<div class="eu-pin"></div><div class="glass eu-tag"><b>TR-1003 · Berlin</b><span>Storm damage · €36,000 settled</span></div>`, ui);
const credit = el('div', 'abs credit', 'Built by <b>Sarib Samdani</b>', ui);

const endCard = el('div', 'abs hero endcard', `<div class="mark">${SOTERIA_MARK}</div><div class="name">SOTERIA</div>
  <div class="tag">Every wagon. Every second. <b>Settled automatically.</b></div>
  <div class="by">Built by <b>Sarib Samdani</b></div>`, ui);
const endParts = Array.from(endCard.children) as HTMLElement[];

const flash = el('div', 'abs flash', '', ui);
const attrib = el('div', 'abs attrib', '© Mapbox © OpenStreetMap · Natural Earth · demo scenario, fictional parties', ui);
const blackout = el('div', 'abs blackout', '', ui);

// ---------------------------------------------------------------- per-frame UI
const show = (e: HTMLElement, o: number, transform = '') => {
  e.style.opacity = String(clamp(o));
  e.style.display = o <= 0.001 ? 'none' : '';
  if (transform) e.style.transform = transform;
};

function safe(x: number, y: number, t: number) {
  const hud = t > T.hudIn && t < T.hudOut;
  let f = 1;
  if (hud && y < 300 && (x < 860 || x > 1380)) f = 0;
  if (hud && x > 1400 && y < 900 && t > T.toasts[0]) f = 0;
  if (hud && x < 560 && y > 200 && y < 620 && t > T.toasts[2] - 1.1) f = 0;
  if (x < 40 || x > 1880 || y < 30 || y > 1050) f = 0;
  return f;
}

function project(lngLat: [number, number], liftM: number): [number, number] {
  const p = map.project(lngLat);
  const z = map.getZoom();
  const mpp = (78271.517 * Math.cos((52.53 * Math.PI) / 180)) / 2 ** z;
  const up = (liftM / mpp) * Math.sin((map.getPitch() * Math.PI) / 180) * 0.9;
  return [p.x - 40, p.y - 40 - up];
}

const w02Temp = (t: number) => {
  if (t < T.land) return 5.0 + 0.08 * Math.sin(t * 3.1) + 0.05 * Math.sin(t * 7.3);
  const x = t - T.land;
  return 5.0 + 6.2 * (1 - Math.exp(-x / 3.9)) + 0.05 * Math.sin(t * 5);
};
const EXC_OPEN = T.toasts[2] - 0.6;
const accrued = (t: number) => (t < EXC_OPEN ? 0 : Math.min(12000, 12000 * easeInOut3(seg(t, EXC_OPEN, T.toasts[5] - 0.1))));

function clockAt(t: number) {
  const lapseFrom = T.land + 1.6;
  const sec = t < lapseFrom ? t - T.land : lapseFrom - T.land + (t - lapseFrom) * 8;
  const total = 18 * 3600 + Math.floor(sec);
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = ((total % 60) + 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

const rps = (t: number) => {
  const burst = t >= T.land ? 150 * Math.exp(-(t - T.land) / 4) + 40 : 0;
  return 24 + burst + 3 * Math.sin(t * 9.1) + 2 * Math.sin(t * 4.3);
};
const totalReadings = (t: number) => {
  let s = 1_204_880;
  for (let x = 0; x < t; x += 0.1) s += rps(x) * 0.1;
  return Math.floor(s);
};

async function updateUI(t: number, frame: number) {
  const [sx, sy] = shake(t);
  mapWrap.style.transform = `translate(${sx}px, ${sy}px)`;
  const L = lightning(t);
  const appO = fadeWindow(t, T.appIn, T.appOut, 0.5, 0.35);
  const payO = fadeWindow(t, T.payIn, T.payOut, 0.4, 0.6);
  const dimO = Math.max(appO, payO);
  const blur = dimO * 10;
  const stormDark = t > T.storm && t < T.appIn + 0.5 ? 1 - 0.18 * seg(t, T.storm, T.storm + 1.5) : 1;
  mapWrap.style.filter = `brightness(${(1 + L * 1.4) * (1 - dimO * 0.45) * stormDark}) contrast(1.08) saturate(${1.1 - 0.25 * seg(t, T.storm, T.storm + 1.5) * (1 - seg(t, T.payIn, T.euIn))})${blur > 0.05 ? ` blur(${blur}px)` : ''}`;

  // rain
  const rainI = seg(t, T.storm, T.storm + 1.6) * (1 - seg(t, T.appIn, T.appIn + 0.8));
  rctx.clearRect(0, 0, 1920, 1080);
  if (rainI > 0) {
    rctx.lineCap = 'round';
    for (let i = 0; i < DROPS.length * rainI; i++) {
      const d = DROPS[i];
      const y = ((d.y + d.v * t) % 1400) - 150;
      const x = d.x + y * 0.28;
      rctx.strokeStyle = `rgba(200,215,255,${d.a * (0.6 + 0.4 * rainI) * (1 + L)})`;
      rctx.lineWidth = d.w;
      rctx.beginPath();
      rctx.moveTo(x, y);
      rctx.lineTo(x - d.len * 0.28, y - d.len);
      rctx.stroke();
    }
  }

  const impactFlash = t >= T.land ? Math.exp(-(t - T.land) * 9) : 0;
  show(flash, Math.max(L * 0.55, impactFlash * 0.95));
  show(redwash, t >= T.land ? (0.16 + 0.14 * Math.sin((t - T.land) * 5.5)) * (1 - seg(t, T.land + 4.6, T.land + 7.6)) : 0);
  show(vignette, 1);
  const fadeIn = 1 - easeOut3(seg(t, 0, 0.9));
  const fadeOut = easeInOut3(seg(t, T.fadeOut, DURATION));
  show(blackout, Math.max(fadeIn, fadeOut));
  show(dimEl, Math.max(fadeWindow(t, 0, T.heroOut + 0.1, 0.01, 0.6) * 0.5, fadeWindow(t, T.endIn, 46, 0.8, 0.1) * 0.5));


  // hook
  const ho = fadeWindow(t, T.hookIn, T.hookOut, 0.4, 0.35);
  show(hook, ho);
  if (ho > 0) {
    const kp = easeOut3(seg(t, T.hookIn, T.hookIn + 0.5));
    hookK.style.opacity = String(kp);
    hookSpans.forEach((s, i) => {
      const p = easeOut3(seg(t, T.hookIn + 0.2 + i * 0.6, T.hookIn + 0.85 + i * 0.6));
      s.style.opacity = String(p);
      s.style.transform = `translateY(${(1 - p) * 30}px)`;
      s.style.filter = `blur(${(1 - p) * 10}px)`;
    });
    hook.style.transform = `scale(${1 + seg(t, T.hookIn, T.hookOut) * 0.04})`;
  }

  // title
  const hp = fadeWindow(t, T.heroIn, T.heroOut, 0.6, 0.5);
  show(hero, hp);
  if (hp > 0) {
    const pin = easeOutExpo(seg(t, T.heroIn, T.heroIn + 1.3));
    heroName.style.letterSpacing = `${lerp(0.62, 0.2, pin)}em`;
    heroName.style.filter = `blur(${(1 - pin) * 14}px)`;
    heroMark.style.transform = `scale(${lerp(0.6, 1, easeOutBack(seg(t, T.heroIn, T.heroIn + 0.8)))})`;
    const tg = easeOut3(seg(t, T.heroIn + 0.6, T.heroIn + 1.3));
    heroTag.style.opacity = String(tg); heroTag.style.transform = `translateY(${(1 - tg) * 18}px)`;
    hero.style.transform = `scale(${1 + seg(t, T.heroIn, T.heroOut) * 0.05}) translateY(${-easeInOut3(seg(t, T.heroOut - 0.5, T.heroOut)) * 20}px)`;
  }

  // Hbf pin
  const pinO = fadeWindow(t, T.pinIn, T.pinOut, 0.6, 0.6);
  show(hbfPin, pinO);
  if (pinO > 0) {
    const [x, y] = project(line.pointAt(572), 0);
    const r = hbfPin.getBoundingClientRect();
    hbfPin.style.transform = `translate(${x - r.width / 2 + sx}px, ${y - r.height + 6 + sy - (1 - easeOut3(seg(t, T.pinIn, T.pinIn + 0.7))) * 30}px)`;
  }

  // HUD (story) and brand (also in the Europe view)
  const hud = fadeWindow(t, T.hudIn, T.hudOut, 0.6, 0.5);
  const hudSlide = (1 - easeOut3(seg(t, T.hudIn, T.hudIn + 0.8))) + easeInOut3(seg(t, T.hudOut - 0.5, T.hudOut));
  const euO = fadeWindow(t, T.euIn + 1.3, T.endIn + 0.3, 0.7, 0.5);
  show(brand, Math.max(hud, euO), `translateY(${-(t < T.appIn ? hudSlide : (1 - easeOut3(seg(t, T.euIn + 1.3, T.euIn + 2.0)))) * 30}px)`);
  brandSub.textContent = t > T.payIn ? 'LIVE NETWORK · EUROPE' : 'REAL-TIME CARGO PROTECTION';
  show(trip, hud, `translateY(${-hudSlide * 30}px)`);
  show(ledger, hud, `translateX(${hudSlide * 80}px)`);
  show(attrib, Math.max(hud, euO, fadeWindow(t, T.endIn, 46)) * 0.9);
  speedEl.textContent = `${Math.round(speedKmh(t))} km/h`;
  speedEl.style.color = t >= T.brake ? (t >= T.stop ? '#f87171' : '#fbbf24') : '#fff';
  clockEl.textContent = clockAt(t);
  lapseEl.textContent = t >= T.land + 1.6 ? '×8' : '';
  blockEl.textContent = blockAt(t).toLocaleString('en-US');
  blockEl.style.fontSize = '15px';
  const r = rps(t);
  rpsEl.textContent = Math.round(r).toString();
  rpsEl.style.color = r > 60 ? '#c4b5fd' : '#fff';
  totalEl.textContent = totalReadings(t).toLocaleString('en-US');
  for (let i = 0; i < BAR_N; i++) {
    const at = t - (BAR_N - 1 - i) * 0.25;
    const v = at < 0 ? 22 : rps(at) + 4 * Math.sin(i * 1.7);
    bars[i].style.height = `${clamp(v / 200, 0.06, 1) * 100}%`;
  }

  // sensor card
  const sp = fadeWindow(t, T.toasts[2] - 1.1, T.hudOut, 0.6, 0.5);
  show(sensor, sp, `translateX(${-(1 - easeOut3(seg(t, T.toasts[2] - 1.1, T.toasts[2] - 0.3))) * 80 - easeInOut3(seg(t, T.hudOut - 0.5, T.hudOut)) * 80}px)`);
  if (sp > 0) {
    const temp = w02Temp(t);
    tempEl.textContent = `${temp >= 0 ? '+' : ''}${temp.toFixed(1)} °C`;
    tempEl.style.color = temp > 8 ? '#f87171' : '#fff';
    rateEl.textContent = temp > 7 ? '1 Hz · near limit' : '4 Hz · heartbeat 10 s';
    rateEl.style.color = temp > 7 ? '#fbbf24' : '#a1a1aa';
    const pts: [number, number][] = [];
    for (let k = 0; k <= 80; k++) {
      const tt = t - 10 + (k / 80) * 10;
      pts.push([(k / 80) * 420, 120 - ((w02Temp(tt) - 3) / 9) * 120]);
    }
    const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    pathEl.setAttribute('d', d);
    areaEl.setAttribute('d', `${d}L420,120L0,120Z`);
    const [hx, hy] = pts[pts.length - 1];
    headDot.setAttribute('cx', String(hx)); headDot.setAttribute('cy', String(hy));
    headDot.setAttribute('fill', temp > 8 ? '#f87171' : '#fff');
    pathEl.setAttribute('stroke', temp > 8 ? '#f87171' : '#fff');
    const acc = accrued(t);
    accEl.textContent = eur(acc);
    accrueBox.style.boxShadow = acc > 0 && acc < 12000 ? `0 0 ${18 + 10 * Math.sin(t * 12)}px rgba(16,185,129,.45)` : 'none';
    if (acc >= 12000) { accEl.textContent = '€12,000 ✓'; accEl.style.color = '#4ade80'; } else accEl.style.color = '#d1fae5';
  }

  // toasts
  let visibleAny = false;
  TOASTS.forEach((d, i) => {
    const e = toastEls[i];
    if (t < d.at || t > T.hudOut + 0.1) { show(e, 0); return; }
    visibleAny = true;
    const p = seg(t, d.at, d.at + 0.55);
    let y = 0, newer = 0;
    for (let j = i + 1; j < TOASTS.length; j++) {
      if (t < TOASTS[j].at) continue;
      const pj = easeOut3(seg(t, TOASTS[j].at, TOASTS[j].at + 0.5));
      y += (toastEls[j].offsetHeight + 12) * pj;
      newer += pj;
    }
    const out = clamp(newer - 2.6) + easeInOut3(seg(t, T.hudOut - 0.45, T.hudOut));
    const x = (1 - easeOutBack(p)) * 470;
    const glow = d.tone === 'payout' ? 1 + 0.6 * Math.exp(-(t - d.at) * 2.5) : 1;
    show(e, clamp(p * 2.2) * (1 - clamp(out)), `translate(${x}px, ${y}px) scale(${lerp(0.94, 1, easeOut3(p))})`);
    e.style.filter = glow > 1.01 ? `brightness(${glow})` : '';
  });
  show(toastBox, visibleAny ? 1 : 0);

  // chips, packets, floats
  const chipO = fadeWindow(t, T.hudIn + 0.6, T.hudOut - 0.2, 0.5, 0.4) * (1 - 0.65 * clamp((t - T.land) * 3) * (1 - seg(t, T.land + 0.8, T.land + 1.6)));
  const launch: { x: number; y: number; at: number }[] = [];
  chipEls.forEach((c, i) => {
    if (chipO <= 0) { show(c.root, 0); return; }
    const al = carAlong(t, c.def.id);
    const visible = al > TUNNEL_END + 8;
    const [x, y] = project(line.pointAt(al), 4.6);
    const o = chipO * (visible ? 1 : 0) * safe(x, y, t);
    let value = '';
    let cls = 'chip';
    if (c.def.id === 'LOCO') { value = `${Math.round(speedKmh(t))} km/h`; if (t >= T.stop) cls += ' warn'; }
    if (c.def.id === 'W02') { const v = w02Temp(t); value = `${v >= 0 ? '+' : ''}${v.toFixed(1)} °C`; if (v > 8) cls += ' hot'; else if (v > 6.5) cls += ' warn'; }
    if (c.def.id === 'W05') {
      const pr = t < T.land ? 4.8 + 0.01 * Math.sin(t * 4) : lerp(4.8, 3.1, easeOut3(seg(t, T.land, T.toasts[1])));
      value = `${pr.toFixed(2)} bar`;
      if (t >= T.land) cls += ' hot';
    }
    if (c.def.id === 'W07') value = `${(-18.3 + 0.06 * Math.sin(t * 2.3)).toFixed(1)} °C`;
    c.val.textContent = value;
    c.root.className = cls;
    const w = c.root.offsetWidth, h = c.root.offsetHeight;
    const pop = easeOutBack(seg(t, T.hudIn + 0.6 + i * 0.12, T.hudIn + 1.1 + i * 0.12));
    show(c.root, o, `translate(${x - w / 2 + sx}px, ${y - h - 26 - c.def.lift + sy}px) scale(${0.6 + 0.4 * pop})`);
    const period = t >= T.land ? 0.5 : 1.0;
    const phase = ((t + i * 0.27) % period) / period;
    c.dot.style.boxShadow = `0 0 ${4 + 14 * (1 - phase)}px ${2 * (1 - phase)}px rgba(131,110,249,${0.9 * (1 - phase)})`;
    c.dot.style.transform = `scale(${1 + 0.6 * (1 - phase) ** 3})`;
    if (o > 0.3) {
      for (let k = 0; k < 3; k++) {
        const at = t - ((t + i * 0.27) % period) - k * period;
        if (t - at < 0.75) launch.push({ x: x + sx - w / 2 + 14, y: y + sy - h - 26 - c.def.lift + h / 2, at });
      }
    }
  });
  const target = { x: 1920 - 56 - 430 + 36, y: 48 + 30 };
  packets.forEach((pEl, k) => {
    const L2 = launch[k];
    if (!L2) { show(pEl, 0); return; }
    const p = easeInOut3(clamp((t - L2.at) / 0.75));
    const cx = (L2.x + target.x) / 2, cy = Math.min(L2.y, target.y) - 160;
    const bx = (1 - p) ** 2 * L2.x + 2 * (1 - p) * p * cx + p * p * target.x;
    const by = (1 - p) ** 2 * L2.y + 2 * (1 - p) * p * cy + p * p * target.y;
    show(pEl, (1 - p * p) * hud, `translate(${bx}px, ${by}px) scale(${1 - 0.5 * p})`);
  });

  FLOATS.forEach((f, i) => {
    const e = floatEls[i];
    const dt = t - f.at;
    if (dt < 0 || dt > 2.6 || t > T.hudOut) { show(e, 0); return; }
    const [x, y] = project(line.pointAt(carAlong(t, f.id)), 4.6);
    const w = e.offsetWidth, h = e.offsetHeight;
    const pop = easeOutBack(clamp(dt / 0.4));
    show(e, clamp(dt / 0.15) * (1 - seg(dt, 2.0, 2.6)) * safe(x, y - 120, t), `translate(${x - w / 2 + sx}px, ${y - h - 40 - easeOut3(clamp(dt / 2.6)) * 150 + sy}px) scale(${0.5 + 0.5 * pop})`);
  });

  const sdt = t - T.land + 0.12;
  if (sdt > -0.1 && sdt < 1.5) {
    const [spx, spy] = project(line.pointAt(OBST_AT + 1), 5.5);
    sparks.forEach((s, i) => {
      const d = SPARKS[i];
      const lt = sdt - d.delay;
      if (lt < 0 || lt > d.life) { show(s, 0); return; }
      show(s, 1 - lt / d.life, `translate(${spx + sx + d.vx * lt}px, ${spy + sy + d.vy * lt + 0.5 * 1800 * lt * lt}px) scale(${1.4 - lt / d.life})`);
    });
  } else sparks.forEach(s => show(s, 0));

  capEls.forEach(c => {
    const { a, b } = c.def;
    if (t < a - 0.05 || t > b + 0.05) { show(c.root, 0); return; }
    show(c.root, 1);
    const out = easeInOut3(seg(t, b - 0.4, b));
    const kp = easeOut3(seg(t, a, a + 0.5));
    c.kicker.style.opacity = String(kp * (1 - out));
    c.kicker.style.transform = `translateX(${(1 - kp) * -30}px)`;
    c.words.forEach((w, i) => {
      const p = easeOut3(seg(t, a + 0.12 + i * 0.075, a + 0.62 + i * 0.075));
      w.style.opacity = String(p * (1 - out));
      w.style.transform = `translateY(${(1 - p) * 46 - out * 24}px)`;
      w.style.filter = `blur(${(1 - p) * 12 + out * 8}px)`;
    });
  });

  // the real app
  show(APP, appO);
  if (appO > 0 && CLIPS.length) {
    const c = clipAt(t);
    const ci = CLIPS.indexOf(c);
    const enter = easeOut3(seg(t, T.appIn, T.appIn + 0.75));
    const leave = easeInOut3(seg(t, T.appOut - 0.45, T.appOut));
    appWin.style.transform = `perspective(2200px) translateY(${(1 - enter) * 160}px) rotateX(${(1 - enter) * 16}deg) scale(${lerp(0.9, 1, enter) * (1 + leave * 0.5)})`;
    appK.style.opacity = String(easeOut3(seg(t, T.appIn + 0.2, T.appIn + 0.7)));
    appTitle.innerHTML = c.title;
    const tp = easeOut3(seg(t, c.a + (ci === 0 ? 0.3 : 0), c.a + 0.45 + (ci === 0 ? 0.3 : 0)));
    appTitle.style.opacity = String(tp);
    appTitle.style.transform = `translateY(${(1 - tp) * 14}px)`;
    // current clip, and a short crossfade from the previous one
    const pf = easeInOut3(seg(t, c.a, c.b));
    const f: Focus = { s: lerp(c.f0.s, c.f1.s, pf), x: lerp(c.f0.x, c.f1.x, pf), y: lerp(c.f0.y, c.f1.y, pf) };
    const [cur, prev] = appImgs;
    await loadImg(cur, recSrc(recFrame(c, t)));
    placeImg(cur, f);
    const xf = ci > 0 ? seg(t, c.a, c.a + 0.22) : 1;
    if (xf < 1) {
      const p = CLIPS[ci - 1];
      await loadImg(prev, recSrc(recFrame(p, Math.min(t, p.b + 0.2))));
      placeImg(prev, p.f1);
      prev.style.opacity = String(1 - xf);
      prev.style.display = '';
    } else prev.style.display = 'none';
    cur.style.opacity = '1';
  }

  // payoff
  show(payoff, payO, `scale(${1 + seg(t, T.payIn, T.payOut) * 0.035})`);
  if (payO > 0) {
    const cnt = easeOutExpo(seg(t, T.payIn + 0.05, T.payIn + 1.1));
    amtEl.textContent = eur(lerp(30000, 36000, cnt));
    amtEl.style.transform = `scale(${lerp(0.92, 1, easeOutBack(seg(t, T.payIn, T.payIn + 0.6)))})`;
    payK.style.opacity = String(easeOut3(seg(t, T.payIn + 0.2, T.payIn + 0.7)));
    const sp2 = easeOut3(seg(t, T.payIn + 0.7, T.payIn + 1.3));
    paySub.style.opacity = String(sp2); paySub.style.transform = `translateY(${(1 - sp2) * 16}px)`;
    cmpEls.forEach((c, i) => {
      const p = easeOutBack(seg(t, T.payIn + 1.3 + i * 0.35, T.payIn + 1.9 + i * 0.35));
      c.style.opacity = String(clamp(p)); c.style.transform = `translateY(${(1 - p) * 40}px)`;
    });
    factEls.forEach((f, i) => {
      const p = easeOut3(seg(t, T.payIn + 2.4 + i * 0.18, T.payIn + 2.9 + i * 0.18));
      f.style.opacity = String(p); f.style.transform = `translateY(${(1 - p) * 20}px)`;
    });
  }

  // Europe
  show(euPanel, euO, `translateX(${(1 - easeOut3(seg(t, T.euIn + 1.3, T.euIn + 2.0))) * 80}px)`);
  if (euO > 0) {
    const c = easeOutExpo(seg(t, T.euIn + 1.4, T.euIn + 3.2));
    const live = Math.max(0, t - T.euIn - 3.2);
    euVals.trains.textContent = Math.round(1284 * c).toLocaleString('en-US');
    euVals.wagons.textContent = Math.round(19402 * c).toLocaleString('en-US');
    euVals.rps.textContent = Math.round((31240 + 420 * Math.sin(t * 5.3) + 260 * Math.sin(t * 2.1)) * c).toLocaleString('en-US');
    euVals.inc.textContent = String(Math.round(3 * c));
    euVals.paid.textContent = eur((214300 + live * 1200) * c);
  }
  const lo = fadeWindow(t, T.euIn + 2.0, T.endIn + 0.2, 0.5, 0.4);
  show(euLabel, lo);
  if (lo > 0) {
    const p = map.project(BERLIN);
    euLabel.style.transform = `translate(${p.x - 40 - 9}px, ${p.y - 40 - 9}px)`;
  }
  show(credit, euO * 0.85);

  // end card
  const eo = fadeWindow(t, T.endIn, 46, 0.6, 0.1);
  show(endCard, eo, `scale(${1 + seg(t, T.endIn, DURATION) * 0.04})`);
  if (eo > 0) {
    endParts.forEach((p, i) => {
      const q = easeOut3(seg(t, T.endIn + 0.15 + i * 0.3, T.endIn + 0.85 + i * 0.3));
      p.style.opacity = String(q);
      p.style.transform = `translateY(${(1 - q) * 26}px)`;
      p.style.filter = `blur(${(1 - q) * 10}px)`;
    });
    endParts[1].style.letterSpacing = `${lerp(0.4, 0.2, easeOutExpo(seg(t, T.endIn + 0.45, T.endIn + 1.8)))}em`;
  }
}

// ---------------------------------------------------------------- entry points
let frameNo = 0;
async function renderFrame(t: number) {
  updateMap(t);
  await updateUI(t, frameNo++);
  await waitIdle();
  await updateUI(t, frameNo);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

const ready = (async () => {
  if (!REC) {
    try {
      const m = await fetch(`${REC_URL}marks.json`).then(r => r.json());
      buildClips(m);
    } catch { /* no recording: the app section stays empty */ }
  }
  await mapReady;
  await document.fonts.ready;
  updateMap(0);
  await waitIdle();
})();

declare global {
  interface Window { __ready: Promise<void>; __frame: (t: number) => Promise<void>; __T: typeof T }
}
window.__ready = ready;
window.__frame = renderFrame;
window.__T = T;
(window as unknown as { __map: mapboxgl.Map }).__map = map;

if (Q.has('t')) {
  ready.then(() => renderFrame(Number(Q.get('t'))));
} else if (Q.has('play')) {
  ready.then(() => {
    const start = performance.now();
    const loop = async () => {
      const t = ((performance.now() - start) / 1000) % DURATION;
      updateMap(t);
      await updateUI(t, Math.floor(t * 30));
      requestAnimationFrame(loop);
    };
    loop();
  });
}
