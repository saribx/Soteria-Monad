// Derived figures for the analytics tab, all computed from what the dashboard
// has seen live: contract events from Monad, receipts and the device stream.
import { SCENARIOS } from '../data/scenarios';
import { accruedEur, live, median } from './store';
import { customerOf, devicesOf } from './cases';
import type { CaseId, ChainEvent } from './types';

const CONTRACTS = import.meta.glob<{ contract_id: string; records: { contract: { contract_penalty: number; contract_deadline_h: number; liability_cap: number } } }>(
  '../../../data/contracts/*.json',
  { eager: true, import: 'default' },
);

const contractTerms = (id: string) => Object.values(CONTRACTS).find(c => c.contract_id === id)?.records.contract;

const CASES: CaseId[] = ['s1', 's3'];

/** Shipment ids of the current run. */
export function currentShipments(): Set<number> {
  const st = live.state;
  if (!st?.live) return new Set();
  return new Set([st.cases.s1.shipmentId, st.cases.s3.shipmentId, st.storm.shipmentId].filter((x): x is number => !!x));
}

const inRun = (e: ChainEvent, sids: Set<number>, wagons: Set<number>) =>
  (e.args.shipment !== undefined && sids.has(Number(e.args.shipment))) || (e.args.wagon !== undefined && wagons.has(Number(e.args.wagon)));

export function runEvents(): ChainEvent[] {
  const sids = currentShipments();
  const wagons = new Set((live.state?.devices ?? []).filter(d => d.bound && d.wagonId !== null).map(d => d.wagonId!));
  return live.chain.events.filter(e => inRun(e, sids, wagons));
}

// ---------------------------------------------------------------- money

export function compensation() {
  const events = runEvents();
  const payouts = events.filter(e => e.name === 'Payout');
  const sum = (reason: number) => payouts.filter(e => Number(e.args.reason) === reason).reduce((n, e) => n + Number(e.args.amountEur), 0);
  const accruing = CASES.flatMap(c => devicesOf(c)).filter(d => d.kind === 'reefer').reduce((n, d) => n + accruedEur(d.key).accrued, 0);
  let pendingDelay = 0;
  let frozenDelay = 0;
  for (const c of CASES) {
    const sid = live.state?.cases[c].shipmentId;
    const delay = events.filter(e => e.name.startsWith('Delay') && Number(e.args.shipment) === sid);
    const accrued = delay.find(e => e.name === 'DelayAccrued');
    const last = delay[delay.length - 1];
    if (!accrued || !last) continue;
    if (last.name === 'DelayAccrued') pendingDelay += Number(accrued.args.penaltyEur);
    if (last.name === 'DelayDisputed') frozenDelay += Number(accrued.args.penaltyEur);
  }
  const paidTxs = payouts.map(e => live.txs.get(e.tx)).filter(t => t?.latencyMs !== undefined);
  return {
    coldChain: sum(1),
    delay: sum(2),
    settled: sum(3),
    accruing,
    pendingDelay,
    frozenDelay,
    payoutCount: payouts.length,
    payoutLatencyMs: median(paidTxs.map(t => t!.latencyMs!)),
    payoutFinalMs: median(paidTxs.filter(t => t!.finalizedAt).map(t => t!.finalizedAt! - t!.sentAt)),
  };
}

// ---------------------------------------------------------------- wagons

export function wagonRows() {
  const events = runEvents();
  const now = Date.now();
  return CASES.flatMap(c => {
    const train = SCENARIOS.find(s => s.case_id === c)?.train_data.train_id ?? c;
    return devicesOf(c)
      .filter(d => d.kind !== 'loco')
      .map(d => {
        const mine = events.filter(e => Number(e.args.wagon) === d.wagonId);
        const ended = mine.filter(e => e.name === 'ExcursionEnded');
        const open = accruedEur(d.key);
        const secondsOut = ended.reduce((n, e) => n + Number(e.args.secondsOut), 0) + (open.open ? (now - open.since) / 1000 : 0);
        const alerts = mine.filter(e => e.name === 'SafetyAlert').map(e => (Number(e.args.code) === 1 ? 'shock' : 'pressure'));
        const s = live.series.get(d.key);
        const value = d.kind === 'tank' ? s?.pressure.at(-1) : s?.temp.at(-1);
        return {
          key: d.key,
          train,
          wagon: d.wagon,
          kind: d.kind,
          goods: d.goods,
          limits: d.limits,
          value,
          secondsOut,
          open: open.open,
          accruing: open.accrued,
          paid: open.paid,
          cap: d.limits.capEur ?? 0,
          alerts,
          readings: d.sent,
          capped: ended.some(e => e.args.capped === true),
        };
      });
  });
}

// ---------------------------------------------------------------- contracts

export function contractRows() {
  const events = runEvents();
  return CASES.flatMap(c => {
    const st = live.state?.cases[c];
    const spec = live.hello?.demo.cases[c];
    if (!st?.shipmentId || !spec || !live.state?.live) return [];
    const sid = st.shipmentId;
    const mine = events.filter(e => Number(e.args.shipment) === sid);
    const booked = mine.find(e => e.name === 'Booked');
    const payouts = mine.filter(e => e.name === 'Payout');
    const auto = payouts.filter(e => Number(e.args.reason) !== 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
    const settled = payouts.filter(e => Number(e.args.reason) === 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
    const delayLast = mine.filter(e => e.name.startsWith('Delay')).at(-1);
    const delay =
      !delayLast ? 'on time'
      : delayLast.name === 'DelayAccrued' ? 'accrued'
      : delayLast.name === 'DelayDisputed' ? 'disputed'
      : Number(delayLast.args.state) === 4 ? 'waived' : 'paid';
    const anchor = mine.find(e => e.name === 'DecisionAnchored');
    const scenario = SCENARIOS.find(s => s.case_id === c);
    return [{
      caseId: c,
      sid,
      ref: spec.shipment_ref,
      customer: customerOf(c),
      route: scenario ? `${scenario.journey.origin.name} → ${scenario.journey.destination.name}` : '',
      bond: booked ? Number(booked.args.bondEur) : 0,
      auto,
      settled,
      delay,
      tier: anchor ? Number(anchor.args.tier) : null,
      terms: contractTerms(spec.contract),
    }];
  });
}

// ---------------------------------------------------------------- activity over time

export interface Bin {
  t: number;
  perSecond: number;
  latencyMs: number;
}

export function activity(windowMs = 300_000, binMs = 5_000) {
  const now = Date.now();
  const start = now - windowMs;
  const n = Math.ceil(windowMs / binMs);
  const counts = new Array(n).fill(0);
  const lat: number[][] = Array.from({ length: n }, () => []);
  const times = live.chain.connected ? live.chain.readingTimes : live.receipts;
  for (const t of times) if (t >= start) counts[Math.min(n - 1, Math.floor((t - start) / binMs))]++;
  for (const tx of live.txs.values()) {
    if (tx.receiptAt && tx.receiptAt >= start && tx.latencyMs !== undefined) lat[Math.min(n - 1, Math.floor((tx.receiptAt - start) / binMs))].push(tx.latencyMs);
  }
  const bins: Bin[] = counts.map((c, i) => ({ t: start + i * binMs, perSecond: c / (binMs / 1000), latencyMs: median(lat[i]) }));

  const labels: Record<string, string> = {
    ExcursionStarted: 'excursion',
    SafetyAlert: 'safety alert',
    Payout: 'payout',
    DelayAccrued: 'delay',
    DecisionAnchored: 'decision',
  };
  const markers = runEvents()
    .filter(e => labels[e.name] && e.at >= start)
    .map(e => ({ at: e.at, name: e.name, label: e.name === 'Payout' ? `€${Number(e.args.amountEur).toLocaleString('en-US')}` : labels[e.name] }));
  const storm = live.state?.storm.startedAt;
  if (storm && storm >= start) markers.push({ at: storm, name: 'Storm', label: 'storm burst' });
  return { bins, markers, start, end: now };
}

// ---------------------------------------------------------------- cost

export function monitoringCost() {
  const st = live.state;
  const spent = st?.budget.spentMon ?? 0;
  const txs = st?.budget.txs ?? 0;
  const perTx = txs ? spent / txs : 0;
  const heartbeat = live.hello?.demo.heartbeat_s ?? 10;
  return { spent, txs, perTx, perWagonDay: perTx * (86_400 / heartbeat), cap: st?.budget.capMon ?? 0 };
}

export function coverage() {
  const wagons = SCENARIOS.filter(s => s.case_id === 's1' || s.case_id === 's3').reduce((n, s) => n + s.train_data.wagons.length, 0);
  const monitored = CASES.flatMap(c => devicesOf(c)).filter(d => d.kind !== 'loco').length;
  const readings = (live.state?.devices ?? []).reduce((n, d) => n + d.sent, 0);
  return { wagons, monitored, readings };
}
