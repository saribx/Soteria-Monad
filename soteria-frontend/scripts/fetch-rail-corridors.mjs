// Pulls the real railway geometry for each incident corridor from OpenStreetMap
// (Overpass API, free, no key) and stitches it into one continuous centre line
// per corridor, so trains on the map sit exactly on the actual track.
//
//   node scripts/fetch-rail-corridors.mjs [route id ...]   (config: data/scenarios.json)
//
// Writes src/data/railCorridors.json. Data © OpenStreetMap contributors (ODbL).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Corridor configs live next to the rest of each scenario in data/scenarios.json:
// `sources` are OSM bounding boxes ([south, west, north, east], main-line track)
// and/or railway relations; `anchor` is roughly where the locomotive stands and
// gets snapped onto the track; the corridor is oriented so that "forward"
// (increasing distance) points towards `toward`, the direction of travel.
const SCENARIOS = JSON.parse(readFileSync(new URL('../../data/scenarios.json', import.meta.url), 'utf8')).scenarios;
const CORRIDORS = SCENARIOS.map(s => ({ id: s.route.id, ...s.corridor }));

const MAX_TURN_DEG = 70; // at junctions; within one OSM way any curve is followed
const STATION_MAX_OFFSET_M = 350;
const MAX_GAP_M = 60;

// Responses are cached on disk (scripts/.overpass-cache, git-ignored), so moving
// an anchor or changing back_m / forward_m re-stitches instantly.
const CACHE_DIR = new URL('./.overpass-cache/', import.meta.url);

async function overpass(query) {
  const cacheFile = new URL(`${createHash('sha1').update(query).digest('hex')}.json`, CACHE_DIR);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const data = await fetchOverpass(query);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

async function fetchOverpass(query) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'soteria-frontend/1.0 (rail corridor export)' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(190000),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.warn(`  retrying (${err.message})`);
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Local equirectangular projection in metres; accurate to well under 0.1 % over a few km.
function makeProjection([lng0, lat0]) {
  const R = 6371008.8;
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * R;
  return {
    toXY: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / ky],
  };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const heading = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]);
const turn = (h1, h2) => {
  let d = Math.abs(h1 - h2) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
};

function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { t, q, d: dist(p, q) };
}

function spanKind(tags) {
  if (tags.tunnel === 'avalanche_protector') return 'snowshed';
  if (tags.tunnel) return 'tunnel';
  if (tags.bridge) return 'bridge';
  return null;
}

function overpassQuery(sources) {
  const parts = sources.map((src, i) => src.relation
    ? `rel(id:${src.relation})->.r${i};.r${i} out skel;way(r.r${i})["railway"="rail"]${src.clip ? `(${src.clip.join(',')})` : ''}->.s${i};`
    : `way["railway"="rail"]["usage"="main"][!"service"](${src.bbox.join(',')})->.s${i};`);
  const all = sources.map((_, i) => `.s${i};`).join('');
  return `[out:json][timeout:180];${parts.join('')}(${all});out geom;`;
}

async function buildCorridor(cfg) {
  const data = await overpass(overpassQuery(cfg.sources));
  // Stations in a second, cheap request over the extent of the track; the
  // ones actually on the stitched line are picked out below.
  const geoms = data.elements.filter(el => el.type === 'way').flatMap(el => el.geometry);
  const extent = [
    Math.min(...geoms.map(g => g.lat)), Math.min(...geoms.map(g => g.lon)),
    Math.max(...geoms.map(g => g.lat)), Math.max(...geoms.map(g => g.lon)),
  ].map(v => v.toFixed(4)).join(',');
  const stationData = await overpass(`[out:json][timeout:120];node["railway"~"^(station|halt)$"]["name"](${extent});out;`);
  data.elements.push(...stationData.elements);

  // Rank of every way = index of the source(s) it came from. Walking forward
  // prefers later sources at junctions (6107 -> 6100 at Spandau), walking
  // backward prefers earlier ones.
  const relationWays = new Map(); // relation id -> Set(way ids)
  for (const el of data.elements) {
    if (el.type === 'relation') relationWays.set(el.id, new Set(el.members.filter(m => m.type === 'way').map(m => m.ref)));
  }
  const inBbox = (el, [s, w, n, e]) => el.geometry.some(g => g.lat >= s && g.lat <= n && g.lon >= w && g.lon <= e);
  const ranksOf = el => cfg.sources
    .map((src, i) => (src.relation ? relationWays.get(src.relation)?.has(el.id) : el.tags?.usage === 'main' && !el.tags?.service && inBbox(el, src.bbox)) ? i : -1)
    .filter(i => i >= 0);

  const proj = makeProjection(cfg.anchor);
  const nodes = new Map(); // id -> xy
  const adj = new Map(); // id -> [{ to, kind, way, minRank, maxRank }]
  const link = (a, b, info) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, ...info });
  };

  const edges = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || el.tags?.service) continue;
    const kind = spanKind(el.tags ?? {});
    const ranks = ranksOf(el);
    const info = { kind, way: el.id, minRank: Math.min(...ranks, 99), maxRank: Math.max(...ranks, 0) };
    el.nodes.forEach((id, i) => nodes.set(id, proj.toXY([el.geometry[i].lon, el.geometry[i].lat])));
    for (let i = 0; i + 1 < el.nodes.length; i++) {
      const [a, b] = [el.nodes[i], el.nodes[i + 1]];
      if (a === b) continue;
      link(a, b, info);
      link(b, a, info);
      edges.push([a, b, kind]);
    }
  }

  // Snap the anchor to the nearest track edge.
  const anchorXY = [0, 0];
  let best = null;
  for (const [a, b, kind] of edges) {
    const hit = projectOnSegment(anchorXY, nodes.get(a), nodes.get(b));
    if (!best || hit.d < best.d) best = { a, b, kind, way: adj.get(a).find(o => o.to === b).way, ...hit };
  }
  if (!best) throw new Error(`${cfg.id}: no track found`);

  // Drop mis-ordered OSM nodes: a point where the line folds back on itself.
  function removeSpikes(points) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i + 1 < points.length; i++) {
        const t = turn(heading(points[i - 1].xy, points[i].xy), heading(points[i].xy, points[i + 1].xy));
        if (t > 150) {
          points.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return points;
  }

  // Orient the snapped edge so a -> b is the direction of travel.
  const towardXY = proj.toXY(cfg.toward);
  const [pa, pb] = [nodes.get(best.a), nodes.get(best.b)];
  if ((pb[0] - pa[0]) * (towardXY[0] - best.q[0]) + (pb[1] - pa[1]) * (towardXY[1] - best.q[1]) < 0) {
    [best.a, best.b] = [best.b, best.a];
  }

  // Walk away from the snapped point in one direction, always taking the
  // straightest continuation (a crossover or junction branch turns sharply).
  function walk(prev, curr, firstKind, firstWay, limitM, forward) {
    const pts = [{ xy: nodes.get(curr), kind: firstKind }];
    const seen = new Set([prev, curr]);
    let length = 0;
    let way = firstWay;
    while (length < limitM) {
      const h = heading(nodes.get(prev), nodes.get(curr));
      const options = (adj.get(curr) ?? [])
        .filter(o => !seen.has(o.to))
        .map(o => ({ ...o, turn: turn(h, heading(nodes.get(curr), nodes.get(o.to))) }));
      const rank = o => (forward ? -o.maxRank : o.minRank);
      const next =
        options.find(o => o.way === way) ??
        options.filter(o => o.turn <= MAX_TURN_DEG).sort((x, y) => rank(x) - rank(y) || x.turn - y.turn)[0];
      if (!next) {
        // OSM sometimes leaves a few metres between consecutive ways (bridges,
        // re-mapped stations). Jump such a gap if a track continues straight ahead.
        const here = nodes.get(curr);
        let jump = null;
        for (const [id, p] of nodes) {
          if (seen.has(id) || !adj.has(id)) continue;
          const d = dist(here, p);
          if (d > MAX_GAP_M || d < 0.01) continue;
          if (turn(h, heading(here, p)) > 25) continue;
          if (!jump || d < jump.d) jump = { id, d };
        }
        if (!jump) break;
        const cont = adj.get(jump.id).map(o => ({ ...o, turn: turn(h, heading(nodes.get(jump.id), nodes.get(o.to))) }))
          .sort((x, y) => x.turn - y.turn)[0];
        length += jump.d;
        pts.push({ xy: nodes.get(jump.id), kind: null });
        seen.add(jump.id);
        prev = curr;
        curr = jump.id;
        way = cont?.way;
        continue;
      }
      way = next.way;
      length += dist(nodes.get(curr), nodes.get(next.to));
      pts.push({ xy: nodes.get(next.to), kind: next.kind });
      seen.add(next.to);
      prev = curr;
      curr = next.to;
    }
    return pts;
  }

  const fwd = walk(best.a, best.b, best.kind, best.way, cfg.forward_m, true);
  const back = walk(best.b, best.a, best.kind, best.way, cfg.back_m, false);

  // Assemble back (reversed) -> anchor -> forward. Each point carries the kind
  // of the segment that *ends* at it; after reversing, shift kinds by one.
  const backRev = back.slice().reverse();
  const kindsBack = backRev.map((_, i) => (i === 0 ? null : back[back.length - i].kind));
  let pts = removeSpikes([
    ...backRev.map((p, i) => ({ xy: p.xy, kind: kindsBack[i] })),
    { xy: best.q, kind: best.kind },
    ...fwd,
  ]);

  // Cumulative distances, trimmed to back_m behind / forward_m ahead of the anchor.
  let cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1].xy, pts[i].xy));
  let anchorIndex = pts.findIndex(p => p.xy === best.q);
  const lo = cum.findIndex(d => d >= cum[anchorIndex] - cfg.back_m);
  let hi = cum.findIndex(d => d > cum[anchorIndex] + cfg.forward_m);
  if (hi === -1) hi = pts.length;
  pts = pts.slice(lo, hi);
  pts[0] = { ...pts[0], kind: null };
  anchorIndex -= lo;
  cum = cum.slice(lo, hi).map(d => d - cum[lo]);

  const spans = [];
  for (let i = 1; i < pts.length; i++) {
    const kind = pts[i].kind;
    if (!kind) continue;
    const last = spans[spans.length - 1];
    if (last && last.kind === kind && Math.abs(last.to - cum[i - 1]) < 0.5) last.to = cum[i];
    else spans.push({ kind, from: cum[i - 1], to: cum[i] });
  }

  // Stations that actually sit on this line.
  const stations = [];
  for (const el of data.elements) {
    if (el.type !== 'node' || !el.tags?.name) continue;
    const p = proj.toXY([el.lon, el.lat]);
    let hit = null;
    for (let i = 1; i < pts.length; i++) {
      const h = projectOnSegment(p, pts[i - 1].xy, pts[i].xy);
      if (!hit || h.d < hit.d) hit = { d: h.d, along: cum[i - 1] + h.t * (cum[i] - cum[i - 1]) };
    }
    if (hit && hit.d <= STATION_MAX_OFFSET_M) {
      stations.push({
        name: el.tags['name:en'] && /[^\x00-\x7F]/.test(el.tags.name) ? `${el.tags['name:en']} (${el.tags.name})` : el.tags.name,
        coordinates: [+el.lon.toFixed(7), +el.lat.toFixed(7)],
        along: Math.round(hit.along),
      });
    }
  }
  stations.sort((a, b) => a.along - b.along);

  const round = v => +v.toFixed(7);
  const corridor = {
    id: cfg.id,
    lengthM: Math.round(cum[cum.length - 1]),
    anchorAlongM: Math.round(cum[anchorIndex]),
    coordinates: pts.map(p => proj.toLngLat(p.xy).map(round)),
    spans: spans.map(sp => ({ kind: sp.kind, from: Math.round(sp.from), to: Math.round(sp.to) })),
    stations,
  };
  console.log(
    `${cfg.id}: ${corridor.coordinates.length} pts, ${corridor.lengthM} m, anchor @ ${corridor.anchorAlongM} m ` +
    `(snapped ${best.d.toFixed(1)} m), ${spans.length} spans, stations: ${stations.map(s => `${s.name}@${s.along}`).join(', ') || '-'}`,
  );
  return corridor;
}

// Optional corridor ids as arguments refresh only those and keep the rest.
const only = process.argv.slice(2);
const out = new URL('../src/data/railCorridors.json', import.meta.url);
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).corridors : [];
const corridors = [];
for (const cfg of CORRIDORS) {
  if (only.length && !only.includes(cfg.id)) {
    const kept = previous.find(c => c.id === cfg.id);
    if (kept) corridors.push(kept);
    continue;
  }
  corridors.push(await buildCorridor(cfg));
  await new Promise(r => setTimeout(r, 1500));
}

writeFileSync(
  out,
  JSON.stringify({
    source: 'OpenStreetMap contributors (ODbL), via Overpass API',
    generated: new Date().toISOString(),
    corridors,
  }),
);
console.log(`wrote ${out.pathname}`);
