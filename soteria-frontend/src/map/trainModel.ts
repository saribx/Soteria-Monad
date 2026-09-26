import type { FeatureCollection, Feature, Polygon, LineString, Point } from 'geojson';
import type { FleetAsset, TrainLivery, TrainWagon } from '../types/fleet';
import { MeasuredLine, measuredCorridor } from './railGeometry';

// Builds a train as stacked fill-extrusion parts that follow the real track
// curve: one locomotive plus exactly one car per wagon in the consist.
// Heights are metres above top of rail.

interface Part {
  from: number; // metres behind the car's front
  to: number;
  left: number; // lateral offset, metres (negative = left of travel)
  right: number;
  base: number;
  top: number;
  color: string;
  glow?: boolean; // lamps / glazing rendered with full emissive strength
  decal?: number; // flat ground marking (spill, scorch) at this opacity instead of a 3D part
  wreck?: boolean; // damage detail, lit brighter so it reads at night
}

const LIVERIES: Record<TrainLivery, { body: string; accent: string; roof: string; length: number; operator: string }> = {
  // Union Pacific "Armour Yellow" with Harbor Mist grey roof and signal-red stripe
  'union-pacific': { body: '#f2b10a', accent: '#b91c1c', roof: '#8a8f98', length: 22.5, operator: 'Union Pacific' },
  // DB Cargo traffic red with light-grey roof (Vectron / BR 193-style electric)
  'db-cargo': { body: '#ec0016', accent: '#f0f0f0', roof: '#9ca3af', length: 18.98, operator: 'DB Cargo' },
};

export const COUPLING_GAP_M = 1.1;
const DARK = '#1b1c20';
const FRAME = '#2b2d33';
const GLASS = '#0b1626';

function bogies(length: number): Part[] {
  const inset = Math.min(3.2, length * 0.16);
  return [inset - 1.4, length - inset - 1.4].map(from => ({
    from, to: from + 2.8, left: -1.25, right: 1.25, base: 0.1, top: 0.95, color: DARK,
  }));
}

const frame = (length: number, width = 2.95): Part => ({
  from: 0.2, to: length - 0.2, left: -width / 2, right: width / 2, base: 0.95, top: 1.3, color: FRAME,
});

function locomotiveParts(livery: TrainLivery): { length: number; parts: Part[] } {
  const l = LIVERIES[livery];
  const L = l.length;
  const w = 1.5;
  const cab = 3.2;
  return {
    length: L,
    parts: [
      ...bogies(L),
      frame(L, 3.05),
      // nose / cab: lower body, glazing band, cab roof
      { from: 0, to: cab, left: -w, right: w, base: 1.3, top: 2.55, color: l.body },
      { from: 0.35, to: cab, left: -w, right: w, base: 2.55, top: 3.35, color: GLASS, glow: true },
      { from: 0, to: 0.35, left: -w, right: w, base: 2.55, top: 3.35, color: l.accent },
      { from: 0, to: cab, left: -w, right: w, base: 3.35, top: 4.05, color: l.body },
      // accent stripe along the body
      { from: cab, to: L - 0.3, left: -w, right: w, base: 1.3, top: 1.75, color: l.accent },
      { from: cab, to: L - 0.3, left: -w, right: w, base: 1.75, top: 4.0, color: l.body },
      // roof equipment (pantograph / radiator hatches)
      { from: cab + 1.2, to: L - 2.2, left: -1.05, right: 1.05, base: 4.0, top: 4.35, color: l.roof },
      { from: cab + 3.5, to: cab + 5.5, left: -0.55, right: 0.55, base: 4.35, top: 4.75, color: '#3f4148' },
      // headlights and ditch lights
      { from: -0.05, to: 0.1, left: -1.2, right: -0.8, base: 1.55, top: 1.85, color: '#fff7d6', glow: true },
      { from: -0.05, to: 0.1, left: 0.8, right: 1.2, base: 1.55, top: 1.85, color: '#fff7d6', glow: true },
      { from: -0.05, to: 0.1, left: -0.25, right: 0.25, base: 3.55, top: 3.8, color: '#fff7d6', glow: true },
      // red tail lamps at the rear cab
      { from: L - 0.1, to: L + 0.05, left: -1.2, right: -0.85, base: 1.55, top: 1.8, color: '#ff2a2a', glow: true },
      { from: L - 0.1, to: L + 0.05, left: 0.85, right: 1.2, base: 1.55, top: 1.8, color: '#ff2a2a', glow: true },
    ],
  };
}

// How a wagon was damaged, read from the incident report's damage description,
// so every scenario's damage shows without per-scenario code.
type DamageKind = 'unit_torn_off' | 'unit_dented' | 'side_torn' | 'tank_dented' | 'coupling_crushed' | 'generic';

export function damageKind(wagon: TrainWagon): DamageKind | null {
  if (!wagon.damaged) return null;
  const text = (wagon.damage ?? '').toLowerCase();
  if (/refrigerat|reefer|cooling/.test(text)) return /torn|ripped|off|destroy/.test(text) ? 'unit_torn_off' : 'unit_dented';
  if (/tank|valve|dome|hazmat|cargo compartment/.test(text)) return 'tank_dented';
  if (/side|wall|panel/.test(text)) return 'side_torn';
  if (/coupl|buffer/.test(text)) return 'coupling_crushed';
  return 'generic';
}

const SCORCH = '#1c1917';

function wagonParts(wagon: TrainWagon): { length: number; parts: Part[] } {
  const damage = damageKind(wagon);

  if (wagon.cargoClass === 'hazmat') {
    // Pressurised tank wagon: horizontal cylinder approximated by stepped slabs.
    const L = 16.5;
    const shell = '#d4d7dc';
    const slabs: [number, number, number][] = [
      [1.35, 1.75, 1.9], [1.75, 2.2, 2.6], [2.2, 3.45, 2.95], [3.45, 3.9, 2.6], [3.9, 4.25, 1.9],
    ];
    const parts: Part[] = [
      ...bogies(L),
      frame(L, 2.8),
      ...slabs.map(([base, top, w]): Part => ({ from: 0.9, to: L - 0.9, left: -w / 2, right: w / 2, base, top, color: shell })),
      // orange hazard band (RID/ADR style) and orange plates at both ends
      { from: L / 2 - 1.6, to: L / 2 + 1.6, left: -1.5, right: 1.5, base: 2.2, top: 3.45, color: '#f97316' },
      { from: 0.6, to: 0.9, left: -0.45, right: 0.45, base: 2.3, top: 2.9, color: '#f97316', glow: true },
      { from: L - 0.9, to: L - 0.6, left: -0.45, right: 0.45, base: 2.3, top: 2.9, color: '#f97316', glow: true },
    ];
    if (damage === 'tank_dented' || damage === 'generic') {
      // Valve dome crushed flat and pushed aside, the broken catenary
      // cantilever still lying across the tank, product seeping out.
      parts.push(
        { from: L / 2 - 0.7, to: L / 2 + 0.5, left: -0.2, right: 0.9, base: 4.2, top: 4.36, color: '#6b7280', wreck: true },
        { from: L / 2 - 0.9, to: L / 2 - 0.5, left: -0.3, right: 0.5, base: 4.25, top: 4.3, color: SCORCH, wreck: true },
        { from: L / 2 - 4.2, to: L / 2 + 2.6, left: -0.1, right: 0.12, base: 4.28, top: 4.45, color: '#c8cdd4', wreck: true },
        { from: L / 2 - 1.3, to: L / 2 - 1.05, left: -2.4, right: 1.6, base: 4.1, top: 4.24, color: '#c8cdd4', wreck: true },
        // dark streak where the product runs down the shell
        { from: L / 2 - 0.4, to: L / 2 + 0.2, left: 1.46, right: 1.5, base: 1.6, top: 4.1, color: '#8a5a12', wreck: true },
        // spill spreading over the ballast on the right-hand side
        { from: L / 2 - 3.0, to: L / 2 + 4.2, left: 0.8, right: 5.2, base: 0, top: 0, color: '#e0a93b', decal: 0.5 },
        { from: L / 2 - 1.2, to: L / 2 + 2.0, left: 1.2, right: 3.6, base: 0, top: 0, color: '#f59e0b', decal: 0.45 },
      );
    } else {
      parts.push({ from: L / 2 - 0.6, to: L / 2 + 0.6, left: -0.6, right: 0.6, base: 4.25, top: 4.6, color: '#9ca3af' });
    }
    return { length: L, parts };
  }

  if (wagon.type === 'refrigerated') {
    const L = 19.0;
    const white = '#e6ebf0';
    const band = wagon.cargoClass === 'pharmaceutical' ? '#0ea5e9' : '#16a34a';
    const crushed = damage === 'coupling_crushed';
    const end = crushed ? L - 1.4 : L - 0.3; // a crushed rear end is shorter
    const start = damage === 'unit_torn_off' ? 1.35 : 0.3; // torn-off unit leaves an open bay
    const parts: Part[] = [
      ...bogies(L),
      frame(L),
      { from: start, to: end, left: -1.45, right: 1.45, base: 1.3, top: 2.45, color: white },
      { from: start, to: end, left: -1.46, right: 1.46, base: 2.45, top: 2.75, color: band },
      { from: start, to: end, left: -1.45, right: 1.45, base: 2.75, top: 4.05, color: white },
      { from: 0.6, to: Math.min(end, L - 0.6), left: -1.2, right: 1.2, base: 4.05, top: 4.22, color: '#c7ced6' },
    ];
    if (damage === 'unit_torn_off') {
      // Reefer unit ripped off by the falling contact wire: an open, dark bay
      // and a gouged side on the wagon, the unit tipped over on the ballast,
      // and the wire still draped over the roof down to the ground.
      parts.push(
        // the empty bay: dark bulkhead, bent mounting brackets, white corner posts
        { from: 1.25, to: 1.35, left: -1.4, right: 1.4, base: 1.3, top: 4.05, color: '#111318', wreck: true },
        { from: 0.3, to: 1.35, left: -1.45, right: -1.25, base: 1.3, top: 4.05, color: white },
        { from: 0.3, to: 1.35, left: 1.25, right: 1.45, base: 1.3, top: 4.05, color: white },
        { from: 0.3, to: 1.35, left: -1.45, right: 1.45, base: 3.85, top: 4.05, color: white },
        { from: 0.5, to: 1.2, left: -0.9, right: -0.6, base: 1.6, top: 1.8, color: '#d1d5db', wreck: true },
        { from: 0.3, to: 0.9, left: 0.5, right: 0.8, base: 1.5, top: 1.65, color: '#d1d5db', wreck: true },
        { from: 0.2, to: 2.8, left: 1.45, right: 1.5, base: 2.1, top: 3.9, color: '#2a2f36', wreck: true },
        { from: 0.2, to: 2.8, left: 1.5, right: 1.53, base: 3.85, top: 3.95, color: '#d1d5db', wreck: true },
        { from: 0.4, to: 2.6, left: 2.4, right: 4.6, base: 0, top: 1.25, color: '#6b7684', wreck: true },
        { from: 0.4, to: 2.6, left: 4.55, right: 4.7, base: 0.2, top: 1.0, color: '#9aa3ad', wreck: true },
        { from: 1.0, to: 1.12, left: 1.5, right: 2.45, base: 0.5, top: 0.62, color: '#f97316', wreck: true },
        // contact wire across the roof and down the side onto the ballast
        { from: 1.6, to: 1.7, left: -1.5, right: 1.5, base: 4.24, top: 4.3, color: '#d4a03a', wreck: true },
        { from: 1.6, to: 1.7, left: 1.5, right: 1.56, base: 0.1, top: 4.3, color: '#d4a03a', wreck: true },
        { from: 1.6, to: 5.5, left: 1.6, right: 1.72, base: 0, top: 0, color: '#d4a03a', decal: 0.95 },
        { from: 0.2, to: 3.2, left: 1.6, right: 5.6, base: 0, top: 0, color: SCORCH, decal: 0.45 },
      );
    } else if (damage === 'unit_dented') {
      // Unit still in place but knocked askew and blackened
      parts.push(
        { from: 0.05, to: 1.3, left: -1.3, right: 0.9, base: 1.8, top: 3.35, color: '#3f4652', wreck: true },
        { from: 0.02, to: 0.1, left: -0.9, right: 0.3, base: 2.7, top: 3.05, color: SCORCH, wreck: true },
      );
    } else {
      parts.push(
        { from: 0.05, to: 1.3, left: -1.1, right: 1.1, base: 1.8, top: 3.6, color: '#5b6573' },
        { from: 0.02, to: 0.1, left: -0.7, right: 0.7, base: 2.9, top: 3.3, color: '#22d3ee', glow: true },
      );
    }
    if (crushed) {
      // Rear end concertinaed by the emergency brake: buckled, lower body
      // section and the coupler pushed in.
      parts.push(
        { from: L - 1.4, to: L - 0.5, left: -1.35, right: 1.2, base: 1.2, top: 3.3, color: '#9aa3ad', wreck: true },
        { from: L - 1.1, to: L - 0.7, left: -1.5, right: -0.9, base: 3.3, top: 3.8, color: '#9aa3ad', wreck: true },
        { from: L - 0.5, to: L - 0.1, left: -0.35, right: 0.35, base: 0.7, top: 1.05, color: SCORCH, wreck: true },
      );
    }
    return { length: L, parts };
  }

  // Sliding-wall covered wagon for general goods (Habbiins-type)
  const L = 18.0;
  const body = '#7a2f22';
  const parts: Part[] = [...bogies(L), frame(L)];
  if (damage === 'side_torn' || damage === 'generic') {
    // Right-hand side wall ripped open by the trunk: the wall is missing over
    // a third of the wagon, pallets show inside, a torn panel is bent
    // outwards and cargo has spilled onto the ballast.
    const [h0, h1] = [L * 0.34, L * 0.66];
    parts.push(
      { from: 0.3, to: L - 0.3, left: -1.45, right: 0.95, base: 1.3, top: 3.95, color: body },
      { from: 0.3, to: h0, left: 0.95, right: 1.45, base: 1.3, top: 3.95, color: body },
      { from: h1, to: L - 0.3, left: 0.95, right: 1.45, base: 1.3, top: 3.95, color: body },
      // the opening: dark interior with pallets of cargo
      { from: h0, to: h1, left: 0.9, right: 0.95, base: 1.3, top: 3.95, color: '#15100b', wreck: true },
      { from: h0 + 0.3, to: h0 + 2.0, left: 0.2, right: 1.1, base: 1.3, top: 2.5, color: '#c89a62', wreck: true },
      { from: h0 + 2.3, to: h1 - 0.4, left: 0.2, right: 1.1, base: 1.3, top: 2.1, color: '#b3854f', wreck: true },
      { from: h0 + 2.5, to: h0 + 3.6, left: 0.3, right: 1.0, base: 2.1, top: 2.9, color: '#dcb27a', wreck: true },
      // bright torn metal along the edges of the hole
      { from: h0 - 0.12, to: h0, left: 1.2, right: 1.5, base: 1.3, top: 3.95, color: '#d1d5db', wreck: true },
      { from: h1, to: h1 + 0.12, left: 1.2, right: 1.5, base: 1.3, top: 3.95, color: '#d1d5db', wreck: true },
      // side panel peeled outwards, and a strip hanging from the roof edge
      { from: h0 - 0.2, to: h0 + 1.8, left: 1.5, right: 1.85, base: 1.1, top: 3.1, color: '#8c3a2b', wreck: true },
      { from: h0 + 1.7, to: h0 + 1.8, left: 1.5, right: 1.9, base: 1.1, top: 3.1, color: '#d1d5db', wreck: true },
      { from: h1 - 1.2, to: h1 - 0.3, left: 1.45, right: 1.6, base: 2.8, top: 3.95, color: '#8c3a2b', wreck: true },
      // cartons spilled onto the ballast
      { from: h0 + 1.0, to: h0 + 2.2, left: 2.2, right: 3.2, base: 0, top: 0.8, color: '#c89a62', wreck: true },
      { from: h0 + 2.8, to: h0 + 3.5, left: 2.0, right: 2.8, base: 0, top: 0.6, color: '#b3854f', wreck: true },
      { from: h0 + 3.9, to: h0 + 4.4, left: 3.1, right: 3.6, base: 0, top: 0.45, color: '#dcb27a', wreck: true },
      { from: h0, to: h1, left: 1.5, right: 4.2, base: 0, top: 0, color: '#6b4f33', decal: 0.45 },
    );
  } else {
    parts.push(
      { from: 0.3, to: L - 0.3, left: -1.45, right: 1.45, base: 1.3, top: 3.95, color: body },
      // vertical door seams: slightly recessed darker slabs
      { from: L / 2 - 0.15, to: L / 2 + 0.15, left: -1.47, right: 1.47, base: 1.35, top: 3.9, color: '#4a1c14' },
    );
  }
  parts.push({ from: 0.3, to: L - 0.3, left: -1.25, right: 1.25, base: 3.95, top: 4.2, color: '#9ca3af' });
  return { length: L, parts };
}

export interface TrainLayout {
  cars: { kind: 'locomotive' | 'wagon'; wagon?: TrainWagon; from: number; to: number; length: number }[];
  lengthM: number;
}

// Positions of every car behind the locomotive's front, in metres.
export function layoutTrain(asset: FleetAsset): TrainLayout {
  const cars: TrainLayout['cars'] = [];
  let cursor = 0;
  const loco = locomotiveParts(asset.track!.livery);
  cars.push({ kind: 'locomotive', from: 0, to: loco.length, length: loco.length });
  cursor = loco.length + COUPLING_GAP_M;
  for (const wagon of asset.wagons ?? []) {
    const { length } = wagonParts(wagon);
    cars.push({ kind: 'wagon', wagon, from: cursor, to: cursor + length, length });
    cursor += length + COUPLING_GAP_M;
  }
  return { cars, lengthM: cursor - COUPLING_GAP_M };
}

export const liveryOperator = (livery: TrainLivery) => LIVERIES[livery].operator;

export interface TrainGeometry {
  parts: Feature<Polygon>[];
  decals: Feature<Polygon>[];
  occupied: Feature<LineString>;
  damage: Feature<Point>[];
  label: Feature<Point>;
}

// `head` is the locomotive's front, metres along the corridor; the train
// trails behind it (towards smaller distances).
export function buildTrainGeometry(asset: FleetAsset, head: number, line: MeasuredLine): TrainGeometry {
  const layout = layoutTrain(asset);
  const parts: Feature<Polygon>[] = [];
  const decals: Feature<Polygon>[] = [];
  const damage: Feature<Point>[] = [];

  layout.cars.forEach((car, index) => {
    const spec = car.kind === 'locomotive' ? locomotiveParts(asset.track!.livery) : wagonParts(car.wagon!);
    const carFront = head - car.from;
    for (const part of spec.parts) {
      // car-local "from" runs backwards from the car's front along the track
      const ring = line.ribbon(carFront - part.from, carFront - part.to, part.left, part.right);
      if (part.decal !== undefined) {
        decals.push({
          type: 'Feature',
          properties: { assetId: asset.id, color: part.color, opacity: part.decal },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
        continue;
      }
      parts.push({
        type: 'Feature',
        properties: {
          assetId: asset.id,
          car: index,
          color: part.color,
          base: part.base,
          top: part.top,
          glow: part.glow ? 1 : part.wreck ? 2 : 0,
          damaged: car.wagon?.damaged ? 1 : 0,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
    if (car.wagon?.damaged) {
      damage.push({
        type: 'Feature',
        properties: { assetId: asset.id, wagonId: car.wagon.id },
        geometry: { type: 'Point', coordinates: line.pointAt(carFront - car.length / 2) },
      });
    }
  });

  return {
    parts,
    decals,
    damage,
    occupied: {
      type: 'Feature',
      properties: { assetId: asset.id, status: asset.status },
      geometry: { type: 'LineString', coordinates: line.slice(head - layout.lengthM - 25, head + 25) },
    },
    label: {
      type: 'Feature',
      properties: {
        assetId: asset.id,
        label: `${asset.name.replace('Freight train ', '')} · ${liveryOperator(asset.track!.livery)} · ${asset.wagons?.length ?? 0} wagons`,
        status: asset.status,
      },
      geometry: { type: 'Point', coordinates: line.pointAt(head) },
    },
  };
}

// Current locomotive position, extrapolated from the last simulation tick so
// the train glides smoothly between React state updates.
export function currentHeadAlong(asset: FleetAsset, nowMs: number, simulating: boolean, speedFactor: number): number {
  const track = asset.track!;
  const line = measuredCorridor(track.corridorId);
  if (!line) return track.headAlongM;
  if (!simulating || asset.speedKmh <= 0) return track.headAlongM;
  const travelled = ((asset.speedKmh / 3.6) * speedFactor * (nowMs - track.updatedAtMs)) / 1000;
  return wrapHead(track.headAlongM + travelled, track.startAlongM, Math.min(line.length - 30, track.destination.alongM));
}

// A running train restarts its run once the locomotive reaches its destination.
export function wrapHead(head: number, start: number, end: number): number {
  if (head <= end) return head;
  const loop = Math.max(1, end - start);
  return start + ((head - start) % loop);
}

export function emptyCollection<G extends Polygon | LineString | Point>(): FeatureCollection<G> {
  return { type: 'FeatureCollection', features: [] };
}
