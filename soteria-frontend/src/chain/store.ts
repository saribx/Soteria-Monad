// Live data for the dashboard, kept outside React so a 4 Hz sensor stream and
// hundreds of chain events a second never re-render the map.
//
// Two sources:
//   relayer  (SSE)        device telemetry at 4 Hz, scenario state, tx latency
//   Monad    (WebSocket)  our contract's events straight from the node
//                         (monadLogs: Proposed -> Voted -> Finalized), block heads
// The chain feed is the source of truth; the relayer's copy of the same events
// only fills in while the browser has no WebSocket to Monad.
import { useSyncExternalStore } from 'react';
import { decodeEventLog, hexToString, parseAbi, type Hex } from 'viem';
import type { ChainEvent, DemoState, Hello, TxInfo } from './types';

export const RELAYER_URL: string = import.meta.env.VITE_RELAYER_URL ?? 'http://localhost:8787';

export const RAIL_EVENTS = parseAbi([
  'event Booked(uint32 indexed shipment, address indexed carrier, address indexed customer, bytes16 ref, uint32 bondEur, uint40 deadline)',
  'event WagonRegistered(uint32 indexed wagon, uint32 indexed shipment, uint8 kind, address device, bytes16 ref)',
  'event Accepted(uint32 indexed shipment)',
  'event Closed(uint32 indexed shipment, uint32 bondReturnedEur)',
  'event Reading(uint32 indexed wagon, bytes32 data)',
  'event ExcursionStarted(uint32 indexed wagon, int16 temp, bool gap)',
  'event ExcursionEnded(uint32 indexed wagon, uint32 secondsOut, uint32 paidEur, bool capped)',
  'event MonitoringGap(uint32 indexed wagon, uint40 lastSeen)',
  'event SafetyAlert(uint32 indexed wagon, uint8 code, uint16 value)',
  'event Arrived(uint32 indexed shipment, bool late)',
  'event Standstill(uint32 indexed shipment, bool stopped)',
  'event DelayAccrued(uint32 indexed shipment, uint32 penaltyEur, uint40 challengeUntil)',
  'event DelayDisputed(uint32 indexed shipment, bytes32 reason)',
  'event DelayResolved(uint32 indexed shipment, uint8 state)',
  'event Payout(uint32 indexed shipment, uint32 indexed wagon, address to, uint32 amountEur, uint8 reason)',
  'event DecisionAnchored(uint32 indexed shipment, bytes16 incident, bytes32 receiptHead, uint8 tier, uint8 keys)',
  'event SettlementProposed(uint32 indexed settlement, uint32 indexed shipment, uint32 amountEur, bool waiveDelay, bytes16 ref, bytes32 evidence)',
  'event SettlementSigned(uint32 indexed settlement, address signer)',
  'event SettlementExecuted(uint32 indexed settlement)',
  'event PoolFunded(address indexed carrier, uint256 amountEur)',
]);

// ---------------------------------------------------------------- channels

type Listener = () => void;

class Channel {
  private version = 0;
  private listeners = new Set<Listener>();
  private queued = false;
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.version;
  bump() {
    this.version++;
    this.listeners.forEach(l => l());
  }
  /** At most one notification per animation frame. */
  bumpSoon() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.bump();
    });
  }
}

export const channels = {
  state: new Channel(), // relayer connection, scenario state, devices
  samples: new Channel(), // 4 Hz telemetry
  chain: new Channel(), // blocks, events, tx stats
  ui: new Channel(),
};

/** Re-render the calling component whenever the channel changes. */
export const useChannel = (c: Channel) => useSyncExternalStore(c.subscribe, c.get);

// ---------------------------------------------------------------- data

export interface Series {
  t: number[];
  temp: number[];
  pressure: number[];
  shock: number[];
  speed: number[];
  escalated: boolean;
}

export interface OnchainMark {
  t: number;
  hash: string;
  latencyMs: number;
  block: number;
}

export interface Toast {
  id: string;
  kind: 'payout' | 'alert' | 'delay' | 'anchor' | 'settlement';
  event: ChainEvent;
  at: number;
}

const SERIES_LEN = 4 * 120; // two minutes at 4 Hz

export const live = {
  relayer: false,
  hello: undefined as Hello | undefined,
  state: undefined as DemoState | undefined,
  series: new Map<string, Series>(),
  onchain: new Map<string, OnchainMark[]>(),
  txs: new Map<string, TxInfo>(),
  latencies: [] as number[], // send -> receipt (block Proposed)
  finality: [] as number[], // send -> Finalized
  receipts: [] as number[], // receipt times, for tx/s when the chain feed is down
  chain: {
    connected: false,
    kind: '' as '' | 'monadLogs' | 'logs',
    block: 0,
    blockAt: 0,
    intervals: [] as number[],
    heads: [] as { n: number; at: number }[],
    blockTimeMs: 0, // average over the last heads (a node may batch heads, so no single interval)
    readings: 0,
    readingTimes: [] as number[],
    events: [] as ChainEvent[],
  },
  toasts: [] as Toast[],
  notifications: [] as Toast[], // every toast, kept for the notification sidebar (newest last)
  ui: { controls: true, focusWagon: null as string | null, controlError: null as string | null },
};

const byKey = new Map<string, ChainEvent>();
const eventListeners = new Set<(e: ChainEvent) => void>();

/** Called once for every new contract event, whichever source saw it first. */
export function onChainEvent(fn: (e: ChainEvent) => void) {
  eventListeners.add(fn);
  return () => {
    eventListeners.delete(fn);
  };
}

const cap = <T,>(arr: T[], n: number) => {
  if (arr.length > n) arr.splice(0, arr.length - n);
};

// ---------------------------------------------------------------- helpers

export function deviceByWagon(wagonId: unknown) {
  return live.state?.devices.find(d => d.wagonId !== null && d.wagonId === Number(wagonId));
}

export function explorerTx(hash: string) {
  const base = live.hello?.explorer;
  return base ? `${base}/tx/${hash}` : undefined;
}

export const median = (arr: number[]) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export const perSecond = (times: number[], windowMs = 5_000) => {
  const now = Date.now();
  let n = 0;
  for (let i = times.length - 1; i >= 0 && now - times[i] < windowMs; i--) n++;
  return n / (windowMs / 1000);
};

/** Compensation accruing right now in a wagon's open excursion (EUR). */
export function accruedEur(deviceKey: string, now = Date.now()) {
  const d = live.state?.devices.find(x => x.key === deviceKey);
  if (!d || d.wagonId === null) return { open: false, accrued: 0, paid: 0, since: 0 };
  const events = live.chain.events.filter(e => Number(e.args.wagon) === d.wagonId);
  const paid = events.filter(e => e.name === 'ExcursionEnded').reduce((n, e) => n + Number(e.args.paidEur), 0);
  const lastStart = [...events].reverse().find(e => e.name === 'ExcursionStarted');
  const lastEnd = [...events].reverse().find(e => e.name === 'ExcursionEnded');
  const open = !!lastStart && (!lastEnd || lastStart.at > lastEnd.at);
  if (!open || !lastStart) return { open: false, accrued: 0, paid, since: 0 };
  const { graceS = 0, rateEur = 0, capEur = 0 } = d.limits;
  const accrued = Math.min(capEur - paid, Math.max(0, (now - lastStart.at) / 1000 - graceS) * rateEur);
  return { open: true, accrued: Math.max(0, accrued), paid, since: lastStart.at };
}

// ---------------------------------------------------------------- events

function eventKey(name: string, tx: string, args: Record<string, unknown>) {
  return `${tx}:${name}:${args.wagon ?? args.shipment ?? args.settlement ?? ''}:${args.signer ?? ''}`;
}

function addEvent(e: Omit<ChainEvent, 'key'>) {
  const key = eventKey(e.name, e.tx, e.args);
  const existing = byKey.get(key);
  if (existing) {
    if (e.source === 'chain') existing.source = 'chain';
    if (e.commit && rank(e.commit) > rank(existing.commit)) {
      existing.commit = e.commit;
      if (e.commit === 'Finalized') existing.finalizedAt = Date.now();
    }
    channels.chain.bumpSoon();
    return;
  }
  const event: ChainEvent = { ...e, key };
  byKey.set(key, event);
  live.chain.events.push(event);
  if (live.chain.events.length > 600) byKey.delete(live.chain.events.shift()!.key);
  toastFor(event);
  eventListeners.forEach(fn => fn(event));
  channels.chain.bumpSoon();
}

const rank = (c?: string) => ['Proposed', 'Voted', 'Finalized', 'Verified'].indexOf(c ?? 'Proposed');

function toastFor(e: ChainEvent) {
  if (Date.now() - e.at > 15_000) return; // history from a snapshot, not news
  const kind =
    e.name === 'Payout' ? 'payout'
    : e.name === 'SafetyAlert' ? 'alert'
    : e.name === 'DelayAccrued' || e.name === 'DelayDisputed' ? 'delay'
    : e.name === 'DecisionAnchored' ? 'anchor'
    : null;
  if (!kind) return;
  const toast = { id: e.key, kind, event: e, at: Date.now() } as Toast;
  live.toasts.push(toast);
  cap(live.toasts, 6);
  live.notifications.push(toast);
  cap(live.notifications, 100);
  channels.ui.bump();
}

export function dismissToast(id: string) {
  live.toasts = live.toasts.filter(t => t.id !== id);
  channels.ui.bump();
}

function normalise(args: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (typeof v === 'string' && /^0x[0-9a-f]{32}$/i.test(v)) out[k] = hexToString(v as Hex, { size: 16 }).replace(/\0+$/, '');
    else out[k] = v as string | number | boolean;
  }
  return out;
}

// ---------------------------------------------------------------- relayer (SSE)

let started = false;

export function startLive() {
  if (started) return;
  started = true;
  const es = new EventSource(`${RELAYER_URL}/api/stream`);

  es.addEventListener('hello', e => {
    live.hello = JSON.parse((e as MessageEvent).data);
    live.relayer = true;
    startChainFeed();
    channels.state.bump();
  });

  es.addEventListener('state', e => {
    const wasLive = live.state?.live;
    live.state = JSON.parse((e as MessageEvent).data);
    if (wasLive && !live.state!.live && !live.state!.busy) {
      live.notifications = []; // a reset ends the run and its notifications
      channels.ui.bump();
    }
    live.relayer = true;
    for (const ev of live.state!.events ?? []) {
      addEvent({ name: ev.name, args: ev.args, tx: ev.tx, block: ev.block, at: ev.at, source: 'relayer' });
    }
    channels.state.bump();
  });

  es.addEventListener('samples', e => {
    const { t, d } = JSON.parse((e as MessageEvent).data) as { t: number; d: Record<string, number[]> };
    for (const [key, [temp, pressure, shock, speed, esc]] of Object.entries(d)) {
      let s = live.series.get(key);
      if (!s) {
        s = { t: [], temp: [], pressure: [], shock: [], speed: [], escalated: false };
        live.series.set(key, s);
      }
      s.t.push(t);
      s.temp.push(temp);
      s.pressure.push(pressure);
      s.shock.push(shock);
      s.speed.push(speed);
      s.escalated = esc === 1;
      if (s.t.length > SERIES_LEN) for (const a of [s.t, s.temp, s.pressure, s.shock, s.speed]) a.shift();
    }
    channels.samples.bump();
  });

  es.addEventListener('tx', e => {
    const tx = JSON.parse((e as MessageEvent).data) as TxInfo;
    const prev = live.txs.get(tx.hash);
    live.txs.set(tx.hash, { ...prev, ...tx });
    if (live.txs.size > 4000) live.txs.delete(live.txs.keys().next().value!);
    if (tx.latencyMs !== undefined && tx.ok) {
      live.latencies.push(tx.latencyMs);
      cap(live.latencies, 300);
      live.receipts.push(tx.receiptAt ?? Date.now());
      cap(live.receipts, 3000);
      if (tx.device && tx.label.startsWith('report')) {
        const marks = live.onchain.get(tx.device) ?? [];
        marks.push({ t: tx.receiptAt ?? Date.now(), hash: tx.hash, latencyMs: tx.latencyMs, block: tx.block ?? 0 });
        cap(marks, 200);
        live.onchain.set(tx.device, marks);
      }
    }
    channels.chain.bumpSoon();
  });

  es.addEventListener('finality', e => {
    const u = JSON.parse((e as MessageEvent).data) as { hash: string; state: string; at: number };
    const tx = live.txs.get(u.hash);
    if (tx && u.state === 'Finalized' && !tx.finalizedAt) {
      tx.finalizedAt = u.at;
      live.finality.push(u.at - tx.sentAt);
      cap(live.finality, 300);
    }
  });

  es.addEventListener('log', e => {
    const logs = JSON.parse((e as MessageEvent).data) as { name: string; args: Record<string, unknown>; tx: string; block: number }[];
    for (const l of logs) addEvent({ name: l.name, args: normalise(l.args), tx: l.tx, block: l.block, at: Date.now(), source: 'relayer' });
  });

  es.onerror = () => {
    if (live.relayer) {
      live.relayer = false;
      channels.state.bump();
    }
  };
}

// ---------------------------------------------------------------- Monad (WebSocket)

let chainStarted = false;

function startChainFeed() {
  if (chainStarted || !live.hello) return;
  chainStarted = true;
  const { ws, rail } = live.hello;
  const subs = new Map<string, 'heads' | 'logs'>();
  let headKind = 'monadNewHeads';
  let logKind: 'monadLogs' | 'logs' = 'monadLogs';

  const connect = () => {
    const socket = new WebSocket(ws);
    const send = (id: number, params: unknown[]) =>
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params }));

    socket.onopen = () => {
      send(1, [headKind]);
      send(2, [logKind, { address: rail }]);
    };
    socket.onmessage = msg => {
      const m = JSON.parse(String(msg.data));
      if (m.id === 1 || m.id === 2) {
        if (m.error) {
          // A node without the Monad subscription types: use the standard ones
          if (m.id === 1 && headKind === 'monadNewHeads') send(1, [(headKind = 'newHeads')]);
          if (m.id === 2 && logKind === 'monadLogs') send(2, [(logKind = 'logs'), { address: rail }]);
          return;
        }
        subs.set(m.result, m.id === 1 ? 'heads' : 'logs');
        if (m.id === 2) {
          live.chain.connected = true;
          live.chain.kind = logKind;
          channels.chain.bump();
        }
        return;
      }
      const which = subs.get(m.params?.subscription);
      const r = m.params?.result;
      if (!which || !r) return;
      if (which === 'heads') {
        const n = Number(BigInt(r.number));
        if (n > live.chain.block) {
          const now = Date.now();
          if (live.chain.blockAt) live.chain.intervals.push(now - live.chain.blockAt);
          cap(live.chain.intervals, 60);
          live.chain.heads.push({ n, at: now });
          cap(live.chain.heads, 40);
          const h = live.chain.heads;
          if (h.length > 5) live.chain.blockTimeMs = (h[h.length - 1].at - h[0].at) / (h[h.length - 1].n - h[0].n);
          live.chain.block = n;
          live.chain.blockAt = now;
          channels.chain.bumpSoon();
        }
        return;
      }
      try {
        const d = decodeEventLog({ abi: RAIL_EVENTS, data: r.data, topics: r.topics });
        const commit = r.commitState ?? 'Proposed';
        if (d.eventName === 'Reading') {
          if (commit === 'Proposed') {
            live.chain.readings++;
            live.chain.readingTimes.push(Date.now());
            cap(live.chain.readingTimes, 4000);
            channels.chain.bumpSoon();
          }
          return;
        }
        addEvent({
          name: d.eventName,
          args: normalise(d.args as Record<string, unknown>),
          tx: r.transactionHash,
          block: Number(BigInt(r.blockNumber)),
          at: Date.now(),
          source: 'chain',
          commit,
        });
      } catch {
        // a log of another contract version
      }
    };
    socket.onclose = () => {
      subs.clear();
      live.chain.connected = false;
      channels.chain.bump();
      setTimeout(connect, 1_000);
    };
    socket.onerror = () => undefined; // close follows and reconnects
  };
  connect();
}

// ---------------------------------------------------------------- controls

// A relayer on a public server only takes controls with its CONTROL_TOKEN.
// Open the dashboard once with ?control=<token>; the browser keeps it.
const TOKEN_KEY = 'soteria-control-token';
function controlToken(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('control');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('control');
      window.history.replaceState(null, '', url.toString());
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export async function control(action: 'live' | 's1' | 's3' | 'storm' | 'reset') {
  const token = controlToken();
  try {
    const res = await fetch(`${RELAYER_URL}/api/${action}`, { method: 'POST', headers: token ? { 'x-control-token': token } : {} });
    setUi({ controlError: res.status === 401 ? 'Control token missing or wrong: open the dashboard once with ?control=<token>' : null });
  } catch {
    setUi({ controlError: 'Relayer not reachable' });
  }
}

export function setUi(patch: Partial<typeof live.ui>) {
  Object.assign(live.ui, patch);
  channels.ui.bump();
}
