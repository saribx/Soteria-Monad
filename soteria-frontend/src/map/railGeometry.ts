import RAIL_CORRIDORS from '../data/railCorridors.json';

// Real track centre lines from OpenStreetMap, stitched by scripts/fetch-rail-corridors.mjs.
export interface RailCorridor {
  id: string;
  lengthM: number;
  anchorAlongM: number;
  coordinates: [number, number][];
  spans: { kind: 'tunnel' | 'bridge' | 'snowshed'; from: number; to: number }[];
  stations: { name: string; coordinates: [number, number]; along: number }[];
}

export const CORRIDORS = (RAIL_CORRIDORS as unknown as { corridors: RailCorridor[] }).corridors;
export const corridorById = (id: string) => CORRIDORS.find(c => c.id === id);

type XY = [number, number];

// A polyline measured in metres along its length, in a local equirectangular
// projection (sub-decimetre accurate over the few kilometres of a corridor).
export class MeasuredLine {
  readonly length: number;
  private readonly xy: XY[];
  private readonly cum: number[];
  private readonly lng0: number;
  private readonly lat0: number;
  private readonly kx: number;
  private readonly ky: number;

  constructor(coordinates: [number, number][]) {
    [this.lng0, this.lat0] = coordinates[0];
    const R = 6371008.8;
    this.kx = (Math.PI / 180) * R * Math.cos((this.lat0 * Math.PI) / 180);
    this.ky = (Math.PI / 180) * R;
    this.xy = coordinates.map(c => this.toXY(c));
    this.cum = [0];
    for (let i = 1; i < this.xy.length; i++) {
      const [a, b] = [this.xy[i - 1], this.xy[i]];
      this.cum.push(this.cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  toXY([lng, lat]: [number, number]): XY {
    return [(lng - this.lng0) * this.kx, (lat - this.lat0) * this.ky];
  }

  toLngLat([x, y]: XY): [number, number] {
    return [this.lng0 + x / this.kx, this.lat0 + y / this.ky];
  }

  private segmentAt(d: number): number {
    let lo = 1;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Position (metres) and unit direction of travel at distance `d` along the line.
  frameAt(d: number): { p: XY; dir: XY } {
    const clamped = Math.max(0, Math.min(this.length, d));
    const i = this.segmentAt(clamped);
    const [a, b] = [this.xy[i - 1], this.xy[i]];
    const segLen = this.cum[i] - this.cum[i - 1] || 1;
    const t = (clamped - this.cum[i - 1]) / segLen;
    return {
      p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      dir: [(b[0] - a[0]) / segLen, (b[1] - a[1]) / segLen],
    };
  }

  pointAt(d: number): [number, number] {
    return this.toLngLat(this.frameAt(d).p);
  }

  // Compass bearing (0 = north, clockwise) of the direction of travel at `d`.
  bearingAt(d: number): number {
    const { dir } = this.frameAt(d);
    return ((Math.atan2(dir[0], dir[1]) * 180) / Math.PI + 360) % 360;
  }

  // Sub-line between two distances, following every vertex in between.
  slice(from: number, to: number): [number, number][] {
    const [d0, d1] = [Math.max(0, Math.min(from, to)), Math.min(this.length, Math.max(from, to))];
    const out: [number, number][] = [this.pointAt(d0)];
    for (let i = 0; i < this.cum.length; i++) {
      if (this.cum[i] > d0 && this.cum[i] < d1) out.push(this.toLngLat(this.xy[i]));
    }
    out.push(this.pointAt(d1));
    return out;
  }

  // Footprint of a body that follows the curve of the track between `from` and
  // `to`, spanning lateral offsets [left, right] metres from the centre line
  // (negative = left of the direction of travel).
  ribbon(from: number, to: number, left: number, right: number, stepM = 2): [number, number][] {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / stepM));
    const leftSide: [number, number][] = [];
    const rightSide: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const d = from + ((to - from) * s) / steps;
      const { p, dir } = this.frameAt(d);
      const normal: XY = [dir[1], -dir[0]]; // points to the right of travel
      leftSide.push(this.toLngLat([p[0] + normal[0] * left, p[1] + normal[1] * left]));
      rightSide.push(this.toLngLat([p[0] + normal[0] * right, p[1] + normal[1] * right]));
    }
    const ring = [...leftSide, ...rightSide.reverse()];
    ring.push(ring[0]);
    return ring;
  }
}

const lineCache = new Map<string, MeasuredLine>();
export function measuredCorridor(id: string): MeasuredLine | undefined {
  if (!lineCache.has(id)) {
    const corridor = corridorById(id);
    if (!corridor) return undefined;
    lineCache.set(id, new MeasuredLine(corridor.coordinates));
  }
  return lineCache.get(id);
}
