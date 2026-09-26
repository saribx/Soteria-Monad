import mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { FleetAsset } from '../types/fleet';
import { CORRIDORS, MeasuredLine, measuredCorridor } from './railGeometry';
import { buildTrainGeometry, emptyCollection, layoutTrain } from './trainModel';

type Expression = mapboxgl.ExpressionSpecification;
type Layer = mapboxgl.LayerSpecification & { slot?: string };

// OpenFreeMap: free, keyless OpenStreetMap vector tiles (OpenMapTiles schema).
// Supplies the global railway network, stations and, without a Mapbox
// token, the building footprints with heights.
const OPENFREEMAP = 'https://tiles.openfreemap.org/planet';

export const STATUS_COLOR: Record<FleetAsset['status'], string> = {
  online: '#38bdf8',
  warning: '#f59e0b',
  offline: '#ef4444',
};

// Screen width in px for a real-world width in metres. Mapbox uses 512 px
// tiles, so one pixel covers 78271.517 * cos(lat) / 2^zoom metres; `k` is
// 1 / cos(lat), per feature where we know it.
function metres(m: number, k: number | Expression = 1.47): Expression {
  const at = (z: number) => ['*', (m * 2 ** z) / 78271.517, k] as Expression;
  return ['interpolate', ['exponential', 2], ['zoom'], 10, at(10), 23, at(23)] as Expression;
}

const minPx = (px: number, width: Expression): Expression =>
  ['interpolate', ['exponential', 2], ['zoom'], 10, ['max', px, width[4]], 23, ['max', px, width[6]]] as Expression;

export interface LayerContext {
  standard: boolean; // Mapbox Standard basemap (3D buildings, trees, landmarks)
  font: string[];
}

function addLayer(map: mapboxgl.Map, ctx: LayerContext, layer: Layer, slot: 'bottom' | 'middle' | 'top') {
  map.addLayer((ctx.standard ? { ...layer, slot } : layer) as mapboxgl.LayerSpecification);
}

// --- static corridor data ----------------------------------------------------

function corridorTrackFeatures(): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const corridor of CORRIDORS) {
    const line = measuredCorridor(corridor.id)!;
    const k = 1 / Math.cos((corridor.coordinates[0][1] * Math.PI) / 180);
    const tunnels = corridor.spans.filter(s => s.kind === 'tunnel').sort((a, b) => a.from - b.from);
    let cursor = 0;
    const push = (from: number, to: number, tunnel: boolean) => {
      if (to - from < 1) return;
      features.push({
        type: 'Feature',
        properties: { routeId: corridor.id, tunnel, k },
        geometry: { type: 'LineString', coordinates: line.slice(from, to) },
      });
    };
    for (const t of tunnels) {
      push(cursor, t.from, false);
      push(t.from, t.to, true);
      cursor = t.to;
    }
    push(cursor, line.length, false);
  }
  return { type: 'FeatureCollection', features };
}

function corridorStationFeatures(): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: CORRIDORS.flatMap(c => c.stations.map(s => ({
      type: 'Feature' as const,
      properties: { name: s.name, routeId: c.id },
      geometry: { type: 'Point' as const, coordinates: s.coordinates },
    }))),
  };
}

// --- dynamic train data -------------------------------------------------------

export interface DynamicData {
  travelled: FeatureCollection<LineString>;
  remaining: FeatureCollection<LineString>;
  trains: FeatureCollection<Polygon>;
  extents: FeatureCollection<LineString>;
  blocked: FeatureCollection<LineString>;
  damage: FeatureCollection<Point>;
  labels: FeatureCollection<Point>;
  obstructions: FeatureCollection<Polygon>;
  decals: FeatureCollection<Polygon>;
}

function ringAround(line: MeasuredLine, center: [number, number], radii: number[], rotation = 0): [number, number][] {
  const [cx, cy] = line.toXY(center);
  const ring = radii.map((r, i) => {
    const a = rotation + (i / radii.length) * Math.PI * 2;
    return line.toLngLat([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  });
  ring.push(ring[0]);
  return ring;
}

// Stretch of track each obstruction model covers, metres relative to its
// position; the closed-track glow spans exactly this.
function obstructionSpan(kind: string): [number, number] {
  if (kind === 'fallen_tree_catenary') return [-1, 15];
  if (kind === 'gantry') return [-0.5, 4];
  if (kind === 'small_boulder') return [-0.5, 3];
  return [-0.5, 5.5]; // boulder
}

// Irregular outline around a point given in track coordinates: `d` metres
// along the line, `y` metres to the right of it; `sd`/`sy` stretch the shape.
function localRing(line: MeasuredLine, d: number, y: number, radii: number[], rotation = 0, sd = 1, sy = 1): [number, number][] {
  const { p, dir } = line.frameAt(d);
  const normal = [dir[1], -dir[0]];
  const ring = radii.map((r, i) => {
    const a = rotation + (i / radii.length) * Math.PI * 2;
    const [u, v] = [Math.cos(a) * r * sd, y + Math.sin(a) * r * sy];
    return line.toLngLat([p[0] + dir[0] * u + normal[0] * v, p[1] + dir[1] * u + normal[1] * v]);
  });
  ring.push(ring[0]);
  return ring;
}

// Polygon from corners in track coordinates [d along, y to the right].
function localPoly(line: MeasuredLine, corners: [number, number][]): [number, number][] {
  const ring = corners.map(([d, y]) => {
    const { p, dir } = line.frameAt(d);
    return line.toLngLat([p[0] + dir[1] * y, p[1] - dir[0] * y]);
  });
  ring.push(ring[0]);
  return ring;
}

// A tapered log from (d0, y0) to (d1, y1) in track coordinates, radius r0 -> r1.
function logQuad(line: MeasuredLine, d0: number, y0: number, d1: number, y1: number, r0: number, r1: number) {
  const len = Math.hypot(d1 - d0, y1 - y0) || 1;
  const [nd, ny] = [-(y1 - y0) / len, (d1 - d0) / len];
  return localPoly(line, [
    [d0 + nd * r0, y0 + ny * r0], [d1 + nd * r1, y1 + ny * r1],
    [d1 - nd * r1, y1 - ny * r1], [d0 - nd * r0, y0 - ny * r0],
  ]);
}

interface ObstructionGeometry {
  parts: Feature<Polygon>[];
  decals: Feature<Polygon>[];
}

function obstructionParts(asset: FleetAsset, head: number, line: MeasuredLine): ObstructionGeometry {
  const obstruction = asset.track?.obstruction;
  const out: ObstructionGeometry = { parts: [], decals: [] };
  if (!obstruction) return out;
  const at = head + obstruction.aheadM;
  const part = (coords: [number, number][], base: number, top: number, color: string): Feature<Polygon> => ({
    type: 'Feature',
    properties: { assetId: asset.id, base, top, color },
    geometry: { type: 'Polygon', coordinates: [coords] },
  });
  const decal = (coords: [number, number][], color: string, opacity: number): Feature<Polygon> => ({
    type: 'Feature',
    properties: { assetId: asset.id, color, opacity },
    geometry: { type: 'Polygon', coordinates: [coords] },
  });

  if (obstruction.kind === 'fallen_tree_catenary') {
    // A plane tree uprooted on the left embankment, lying across the track
    // with its crown on the right, well clear of the locomotive. It took the
    // overhead line down with it: a sheared mast, the cantilever resting on
    // the trunk, the contact wire on the ballast.
    const P = out.parts;
    const trunkAt = (y: number) => at + 3 + (y + 9) * 0.12; // slight diagonal
    const box = (d0: number, d1: number, y0: number, y1: number, base: number, top: number, color: string) =>
      P.push(part(line.ribbon(d0, d1, y0, y1), base, top, color));

    // Root plate standing up at the stump, with the crater it tore open
    box(trunkAt(-9) - 0.35, trunkAt(-9) + 0.35, -12, -7.8, 0, 1.2, '#6b4c30');
    box(trunkAt(-9) - 0.3, trunkAt(-9) + 0.3, -11.6, -8.2, 1.2, 2.4, '#77563a');
    box(trunkAt(-9) - 0.25, trunkAt(-9) + 0.25, -10.9, -8.9, 2.4, 3.1, '#825f40');
    for (const [y, h] of [[-11.8, 2.2], [-8.1, 1.9], [-10.2, 3.5], [-9.3, 3.3]] as const) {
      box(trunkAt(-9) - 0.08, trunkAt(-9) + 0.08, y - 0.08, y + 0.08, 0, h, '#4a3524');
    }
    out.decals.push(decal(localRing(line, trunkAt(-9) - 1.6, -10, [1.6, 1.3, 1.8, 1.4, 1.7, 1.2], 0.3, 1, 1.4), '#24170d', 0.8));

    // Trunk: one straight log lying diagonally across the track, tapering
    // from 0.95 m to 0.45 m, rounded by three stacked slabs
    const [rootD, tipD] = [trunkAt(-8.2), trunkAt(7.5)];
    const log = (r0: number, r1: number, base: number, top: number, color: string) =>
      P.push(part(logQuad(line, rootD, -8.2, tipD, 7.5, r0, r1), base, top, color));
    log(0.33, 0.16, 0.05, 0.22, '#5c4633');
    log(0.48, 0.23, 0.22, 0.78, '#7a5c43');
    log(0.33, 0.16, 0.78, 0.95, '#977656');
    // Limbs splaying out towards the crown
    for (const [y0, dEnd, yEnd, base, r] of [
      [2.5, -2.2, 7.8, 0.35, 0.16], [3.2, 2.4, 8.4, 0.45, 0.15], [5.0, -3.4, 9.8, 0.5, 0.12],
      [5.4, 3.6, 10.4, 0.6, 0.12], [6.2, 0.6, 12.0, 0.85, 0.13],
    ] as const) {
      const d0 = trunkAt(y0);
      P.push(part(logQuad(line, d0, y0, d0 + dEnd, yEnd, r, r * 0.5), base, base + r * 2, '#7a5c43'));
    }

    // Crown, flattened where it hit the ground: layered foliage in several greens
    const crownD = trunkAt(9) + 0.2;
    const foliage: [number, number, number[], number, number, number, string][] = [
      [0, 9.5, [4.6, 3.9, 5.1, 4.2, 4.8, 3.7, 4.4, 4.0], 0.2, 2.2, 0.0, '#3a7030'],
      [-1.8, 8.0, [2.8, 2.3, 3.1, 2.5, 2.7, 2.2], 1.4, 3.3, 0.5, '#45823a'],
      [1.9, 10.2, [3.0, 2.6, 3.3, 2.4, 2.9, 2.6], 1.2, 3.6, 1.1, '#4d8f40'],
      [0.3, 12.0, [2.4, 2.0, 2.6, 2.1, 2.3], 1.6, 3.9, 0.3, '#56994a'],
      [-0.6, 9.4, [1.8, 1.5, 2.0, 1.6, 1.7], 3.2, 4.4, 0.9, '#63a652'],
      [2.4, 7.4, [1.5, 1.2, 1.7, 1.3], 2.6, 3.8, 0.2, '#6fb35c'],
      [-2.6, 11.4, [1.4, 1.2, 1.5, 1.1], 2.8, 4.0, 1.4, '#5a9d48'],
    ];
    for (const [dOff, y, radii, base, top, rot, color] of foliage) {
      P.push(part(localRing(line, crownD + dOff, y, radii, rot), base, top, color));
    }
    // Leaves and twigs strewn over the ballast
    out.decals.push(decal(localRing(line, crownD - 0.5, 8.5, [6.2, 5.1, 6.8, 5.5, 6.4, 4.9, 6.0, 5.3], 0.2, 1, 1.15), '#2f5a26', 0.55));
    out.decals.push(decal(localRing(line, at + 1.2, 1.5, [2.4, 1.8, 2.6, 2.0, 2.2], 0.7, 1, 1.8), '#3b6a2f', 0.4));

    // Overhead line: mast sheared at the foot on the left, fallen forwards
    box(at + 11.6, at + 12.2, -4.7, -4.1, 0, 1.4, '#8d8d8d');
    box(at + 12.2, at + 20.5, -4.8, -4.5, 0, 0.35, '#7c8591');
    // cantilever arm lying across the rails on top of the trunk
    const cantD = trunkAt(-1) + 0.9;
    box(cantD - 0.12, cantD + 0.12, -4.3, 1.4, 0.95, 1.12, '#b4bac3');
    // contact wire torn down onto the ballast, snaking ahead of the train
    // (flat ground line: hair-thin extrusions render as tall panels)
    const wire = (d0: number, y0: number, d1: number, y1: number) =>
      out.decals.push(decal(logQuad(line, d0, y0, d1, y1, 0.07, 0.07), '#d4a03a', 0.95));
    wire(at + 0.3, -0.2, trunkAt(0) - 0.6, 0.1);
    wire(trunkAt(0) + 0.6, 0.2, at + 9, 1.1);
    wire(at + 9, 1.1, at + 13, 0.4);
    wire(at + 13, 0.4, at + 17, -2.6);
    wire(at + 17, -2.6, at + 20, -4.4);
    return out;
  }
  if (obstruction.kind === 'gantry') {
    // Collapsed catenary gantry lying across both tracks, plus debris
    const center = line.pointAt(at + 2);
    out.parts.push(
      part(line.ribbon(at + 0.5, at + 1.3, -6.5, 6.5), 0.2, 1.1, '#8b9099'),
      part(line.ribbon(at + 2.2, at + 2.9, -5.5, 5.8), 0.5, 1.2, '#6b7079'),
      part(line.ribbon(at - 0.3, at + 3.6, -6.2, -5.3), 0, 2.6, '#8b9099'),
      part(ringAround(line, center, [1.4, 1.1, 1.6, 1.2, 1.5, 1.0, 1.3], 0.4), 0, 1.4, '#5b5249'),
    );
    return out;
  }
  // Rockfall boulder sitting on the rails ('boulder', 'small_boulder')
  const size = obstruction.kind === 'small_boulder' ? 0.5 : 1;
  const center = line.pointAt(at + 1.5 * size);
  out.parts.push(
    part(ringAround(line, center, [1.9, 1.5, 2.1, 1.7, 1.8, 1.4, 2.0, 1.6].map(r => r * size), 0.3), 0, 1.5 * size, '#6d6258'),
    part(ringAround(line, center, [1.3, 1.1, 1.4, 1.0, 1.2, 1.3].map(r => r * size), 0.9), 1.5 * size, 2.4 * size, '#7d7166'),
    part(ringAround(line, line.pointAt(at + 4 * size), [0.7, 0.5, 0.8, 0.6, 0.7]), 0, 0.7, '#5f554c'),
  );
  return out;
}

export function buildDynamicData(assets: FleetAsset[], headOf: (asset: FleetAsset) => number): DynamicData {
  const data: DynamicData = {
    travelled: emptyCollection(),
    remaining: emptyCollection(),
    trains: emptyCollection(),
    extents: emptyCollection(),
    blocked: emptyCollection(),
    damage: emptyCollection(),
    labels: emptyCollection(),
    obstructions: emptyCollection(),
    decals: emptyCollection(),
  };
  for (const asset of assets) {
    if (!asset.track) continue;
    const line = measuredCorridor(asset.track.corridorId);
    if (!line) continue;
    const head = headOf(asset);
    const geometry = buildTrainGeometry(asset, head, line);
    data.trains.features.push(...geometry.parts);
    data.decals.features.push(...geometry.decals);
    data.damage.features.push(...geometry.damage);
    data.labels.features.push(geometry.label);
    const tail = head - layoutTrain(asset).lengthM;
    data.extents.features.push({
      type: 'Feature',
      properties: { assetId: asset.id, color: STATUS_COLOR[asset.status] },
      geometry: { type: 'LineString', coordinates: line.slice(tail, head) },
    });
    // Journey so far (grey) and still ahead (glowing blue)
    const { origin, destination } = asset.track;
    if (tail - origin.alongM > 1) {
      data.travelled.features.push({
        type: 'Feature',
        properties: { assetId: asset.id },
        geometry: { type: 'LineString', coordinates: line.slice(origin.alongM, tail) },
      });
    }
    if (destination.alongM - head > 1) {
      data.remaining.features.push({
        type: 'Feature',
        properties: { assetId: asset.id },
        geometry: { type: 'LineString', coordinates: line.slice(head, destination.alongM) },
      });
    }
    const obstacle = obstructionParts(asset, head, line);
    data.obstructions.features.push(...obstacle.parts);
    data.decals.features.push(...obstacle.decals);
    const obstruction = asset.track.obstruction;
    if (asset.track.trackBlocked && obstruction) {
      const at = head + obstruction.aheadM;
      const [from, to] = obstructionSpan(obstruction.kind);
      data.blocked.features.push({
        type: 'Feature',
        properties: { assetId: asset.id },
        geometry: { type: 'LineString', coordinates: line.slice(at + from, at + to) },
      });
    }
  }
  return data;
}

export function setDynamicData(map: mapboxgl.Map, data: DynamicData) {
  const set = (id: string, fc: FeatureCollection) => (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(fc);
  set('route-travelled', data.travelled);
  set('route-remaining', data.remaining);
  set('trains', data.trains);
  set('train-extents', data.extents);
  set('track-blocked', data.blocked);
  set('train-damage', data.damage);
  set('train-labels', data.labels);
  set('obstructions', data.obstructions);
  set('ground-decals', data.decals);
}

// --- layer setup ---------------------------------------------------------------

export function addSoteriaLayers(map: mapboxgl.Map, ctx: LayerContext) {
  const layer = (l: Layer, slot: 'bottom' | 'middle' | 'top' = 'middle') => addLayer(map, ctx, l, slot);

  map.addSource('osm', {
    type: 'vector',
    url: OPENFREEMAP,
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  });

  // Without the Mapbox Standard basemap, extrude OSM buildings ourselves.
  if (!ctx.standard) {
    layer({
      id: 'osm-buildings-3d',
      type: 'fill-extrusion',
      source: 'osm',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#3a3d45', 60, '#5b606b'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.92,
      },
    });
  }

  // ---- Global railway network (OSM) -------------------------------------------
  const isRail: Expression = ['==', ['get', 'class'], 'rail'];
  const isMain: Expression = ['!', ['has', 'service']];
  layer({
    id: 'rail-network',
    type: 'line',
    source: 'osm',
    'source-layer': 'transportation',
    minzoom: 5,
    filter: ['all', isRail, ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['case', isMain, '#e2e8f0', '#94a3b8'],
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 0.6, 10, ['case', isMain, 1.6, 0.8], 14, ['case', isMain, 3, 1.6], 17, 6],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 10, 0.7, 16.5, 0.85, 17.5, 0.35],
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'rail-network-ties',
    type: 'line',
    source: 'osm',
    'source-layer': 'transportation',
    minzoom: 12,
    filter: ['all', isRail, ['!=', ['get', 'brunnel'], 'tunnel']],
    paint: {
      'line-color': '#e2e8f0',
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 15, 7],
      'line-dasharray': [0.12, 1.4],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 15.5, 0.5, 16.5, 0],
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'rail-network-tunnels',
    type: 'line',
    source: 'osm',
    'source-layer': 'transportation',
    minzoom: 9,
    filter: ['all', isRail, ['==', ['get', 'brunnel'], 'tunnel']],
    paint: {
      'line-color': '#cbd5e1',
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 16, 3],
      'line-dasharray': [2, 2],
      'line-opacity': 0.45,
      'line-emissive-strength': 1,
    },
  });

  // ---- Incident corridors: real track in full detail --------------------------
  map.addSource('corridor-tracks', { type: 'geojson', data: corridorTrackFeatures() });
  const k: Expression = ['get', 'k'];
  const open: Expression = ['!', ['get', 'tunnel']];

  // Journey lines under the track detail: travelled grey, remaining blue
  map.addSource('route-travelled', { type: 'geojson', data: emptyCollection() });
  map.addSource('route-remaining', { type: 'geojson', data: emptyCollection() });
  layer({
    id: 'route-travelled',
    type: 'line',
    source: 'route-travelled',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#9ca3af',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 5, 16, 10, 18, 22],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 16, 0.6, 18, 0.45],
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'route-remaining-glow',
    type: 'line',
    source: 'route-remaining',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#3b82f6',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 8, 12, 16, 16, 30, 18, 60],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 4, 18, 24],
      'line-opacity': 0.7,
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'route-remaining-core',
    type: 'line',
    source: 'route-remaining',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#7cc4ff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 3.5, 16, 5, 18, 9],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 16.5, 0.9, 18, 0.55],
      'line-emissive-strength': 1,
    },
  });

  layer({
    id: 'corridor-ballast',
    type: 'line',
    source: 'corridor-tracks',
    minzoom: 14,
    filter: open,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': '#6f675d', 'line-width': minPx(2, metres(4.4, k)), 'line-opacity': 0.95 },
  });
  layer({
    id: 'corridor-sleepers',
    type: 'line',
    source: 'corridor-tracks',
    minzoom: 15.5,
    filter: open,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    // 2.6 m concrete sleepers, 0.26 m thick at 0.6 m spacing (dash units are line widths)
    paint: { 'line-color': '#9b958c', 'line-width': metres(2.6, k), 'line-dasharray': [0.1, 0.13] },
  });
  for (const side of [-1, 1]) {
    layer({
      id: `corridor-rail-${side < 0 ? 'left' : 'right'}`,
      type: 'line',
      source: 'corridor-tracks',
      minzoom: 15,
      filter: open,
      layout: { 'line-join': 'round' },
      // standard gauge: rail heads 1.435 m apart
      paint: {
        'line-color': '#d7dde5',
        'line-width': minPx(1, metres(0.075, k)),
        'line-offset': metres(side * 0.7175, k),
        'line-emissive-strength': 0.6,
      },
    });
  }
  layer({
    id: 'corridor-tunnel',
    type: 'line',
    source: 'corridor-tracks',
    minzoom: 8,
    filter: ['get', 'tunnel'],
    paint: { 'line-color': '#e2e8f0', 'line-width': 2, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.55, 'line-emissive-strength': 1 },
  });

  // ---- Highlight: the track section a train occupies, and closed track ahead --
  map.addSource('train-extents', { type: 'geojson', data: emptyCollection() });
  map.addSource('track-blocked', { type: 'geojson', data: emptyCollection() });
  layer({
    id: 'track-blocked-glow',
    type: 'line',
    source: 'track-blocked',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ef4444',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 15, 16, 18, 44],
      'line-blur': 6,
      'line-opacity': 0.55,
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'track-blocked-core',
    type: 'line',
    source: 'track-blocked',
    paint: {
      'line-color': '#fca5a5',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 16, 3],
      'line-dasharray': [2, 1.5],
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'train-extent-glow',
    type: 'line',
    source: 'train-extents',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 12, 15, 22, 18, 44],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 6, 3, 18, 22],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 15, 0.7, 17, 0.45],
      'line-emissive-strength': 1,
    },
  });
  layer({
    id: 'train-extent-core',
    type: 'line',
    source: 'train-extents',
    maxzoom: 15.5,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 14, 6],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 1, 15.5, 0],
      'line-emissive-strength': 1,
    },
  });

  // ---- Stations ------------------------------------------------------------------
  if (!ctx.standard) {
    // Mapbox Standard already renders transit stations; the fallback uses OSM POIs.
    layer({
      id: 'osm-stations',
      type: 'circle',
      source: 'osm',
      'source-layer': 'poi',
      minzoom: 11,
      filter: ['all', ['==', ['get', 'class'], 'railway'], ['in', ['get', 'subclass'], ['literal', ['station', 'halt']]]],
      paint: { 'circle-radius': 4, 'circle-color': '#f8fafc', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 2 },
    });
    layer({
      id: 'osm-station-labels',
      type: 'symbol',
      source: 'osm',
      'source-layer': 'poi',
      minzoom: 12,
      filter: ['all', ['==', ['get', 'class'], 'railway'], ['in', ['get', 'subclass'], ['literal', ['station', 'halt']]]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ctx.font,
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#f1f5f9', 'text-halo-color': '#0b0b0f', 'text-halo-width': 1.4 },
    }, 'top');
  }
  // Mapbox Standard labels stations itself; the fallback needs our own
  if (!ctx.standard) map.addSource('corridor-stations', { type: 'geojson', data: corridorStationFeatures() });
  if (!ctx.standard) layer({
    id: 'corridor-station-dots',
    type: 'circle',
    source: 'corridor-stations',
    minzoom: 10,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7],
      'circle-color': '#0b0b0f',
      'circle-stroke-color': '#f8fafc',
      'circle-stroke-width': 2.5,
      'circle-pitch-alignment': 'map',
      'circle-emissive-strength': 1,
    },
  }, 'top');
  if (!ctx.standard) layer({
    id: 'corridor-station-labels',
    type: 'symbol',
    source: 'corridor-stations',
    minzoom: 10,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ctx.font,
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11, 16, 14],
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b0b0f', 'text-halo-width': 1.6, 'text-emissive-strength': 1 },
  }, 'top');

  // ---- Trains ---------------------------------------------------------------------
  map.addSource('trains', { type: 'geojson', data: emptyCollection() });
  map.addSource('obstructions', { type: 'geojson', data: emptyCollection() });
  map.addSource('train-damage', { type: 'geojson', data: emptyCollection() });
  map.addSource('train-labels', { type: 'geojson', data: emptyCollection() });

  // Flat ground marks: spills, scorch, uprooted soil, strewn leaves
  map.addSource('ground-decals', { type: 'geojson', data: emptyCollection() });
  layer({
    id: 'ground-decals',
    type: 'fill',
    source: 'ground-decals',
    minzoom: 14,
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['get', 'opacity'],
      'fill-antialias': true,
      'fill-emissive-strength': 0.7,
    },
  });
  layer({
    id: 'train-damage-halo',
    type: 'circle',
    source: 'train-damage',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 13, 6, 18, 90],
      'circle-color': '#ef4444',
      'circle-blur': 0.7,
      'circle-opacity': 0.6,
      'circle-pitch-alignment': 'map',
      'circle-emissive-strength': 1,
    },
  });
  const extrusion = (id: string, source: string, filter: Expression | undefined, emissive: number): Layer => ({
    id,
    type: 'fill-extrusion',
    source,
    minzoom: 13,
    ...(filter ? { filter } : {}),
    paint: {
      'fill-extrusion-color': ['get', 'color'],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-height': ['get', 'top'],
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': false,
      'fill-extrusion-emissive-strength': emissive,
    } as mapboxgl.FillExtrusionLayerSpecification['paint'],
  });
  layer(extrusion('trains-body', 'trains', ['==', ['get', 'glow'], 0], 0.5));
  layer(extrusion('trains-lamps', 'trains', ['==', ['get', 'glow'], 1], 1));
  // Damage details and the obstruction are lit brighter so they read at night
  layer(extrusion('trains-wreck', 'trains', ['==', ['get', 'glow'], 2], 0.8));
  layer(extrusion('obstructions-3d', 'obstructions', undefined, 0.7));

  layer({
    id: 'train-labels',
    type: 'symbol',
    source: 'train-labels',
    minzoom: 14.5,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ctx.font,
      'text-size': 12,
      'text-anchor': 'bottom',
      'text-offset': [0, -2.2],
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': ['match', ['get', 'status'], 'offline', '#fecaca', 'warning', '#fde68a', '#e0f2fe'],
      'text-halo-color': '#0b0b0f',
      'text-halo-width': 1.8,
      'text-emissive-strength': 1,
    },
  }, 'top');
}

export const TRAIN_HIT_LAYERS = ['trains-body', 'trains-lamps', 'trains-wreck', 'train-extent-core'];
