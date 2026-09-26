// The demo: two booked trains whose sensors report to SoteriaRail, three
// scripted incidents (s1 reefer failure, s3 storm tree, corridor storm) and a
// keeper that nudges the contract where only time has passed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, hexToNumber, hexToString, pad, stringToHex, toHex, type Address, type Hex } from 'viem';
import { DEMO, NETWORK, RELAYER_DIR, contractTerms, soteriaDecision, trainOf, type WagonSpec } from './config.js';
import { BudgetExhausted, RAIL, Sender, budget, call, onLogs, readRail, rpc, sendMode, type DecodedLog } from './chain.js';
import { Device, KIND_CODE, calibrate, setDeviceRail } from './devices.js';
import { deviceIds, roleAccount } from './keys.js';
import { LocoModel, ReeferModel, TankModel } from './physics.js';

export type CaseId = 's1' | 's3';
export type Phase = 'idle' | 'normal' | 'incident';

export interface Step {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  tx?: Hex;
  detail?: string;
  atMs?: number;
}

export interface ChainEvent {
  name: string;
  args: Record<string, string | number | boolean>;
  tx: Hex;
  block: number;
  at: number;
}

interface StepDef {
  id: string;
  label: string;
  at?: number; // seconds after the start of the run
  wait?: number; // seconds after the previous step
  waitFor?: (e: ChainEvent) => boolean;
  timeout?: number; // seconds
  detail?: (e: ChainEvent) => string;
  run?: () => Promise<{ tx?: Hex; detail?: string } | void>;
}

interface Mirror {
  sid: number;
  caseId: CaseId | 'storm';
  stoppedAt?: number;
  delayState: number;
  delayAt?: number;
  working?: boolean;
}

interface Run {
  running: boolean;
  steps: Step[];
  startedAt?: number;
}

interface CaseRun extends Run {
  phase: Phase;
  shipmentId?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bytes16 = (s: string) => stringToHex(s, { size: 16 });
const STATE_FILE = resolve(RELAYER_DIR, '.state', `${NETWORK.name}.json`);

export function plain(args: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (typeof v === 'string' && /^0x[0-9a-f]{32}$/i.test(v)) out[k] = hexToString(v as Hex, { size: 16 }).replace(/\0+$/, '');
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

export class Demo {
  readonly devices = new Map<string, Device>();
  private carrier = new Sender(roleAccount('carrier'), rpc.pinFor(0));
  private customers = {
    s1: new Sender(roleAccount('customer_s1'), rpc.pinFor(1)),
    s3: new Sender(roleAccount('customer_s3'), rpc.pinFor(2)),
    storm: new Sender(roleAccount('customer_storm'), rpc.pinFor(3)),
  };
  live = false;
  busy?: string;
  cases: Record<CaseId, CaseRun> = {
    s1: { phase: 'idle', running: false, steps: [] },
    s3: { phase: 'idle', running: false, steps: [] },
  };
  storm: Run & { shipmentId?: number } = { running: false, steps: [] };
  readonly events: ChainEvent[] = [];
  private mirrors = new Map<number, Mirror>();
  private generation = 0;

  constructor(
    readonly rail: Address,
    private changed: () => void,
    private log: (m: string) => void,
  ) {
    setDeviceRail(rail);
    const deviceLog = (d: Device, m: string) => this.log(`${d.id.key}: ${m}`);
    deviceIds().forEach((id, n) => {
      const pin = rpc.pinFor(n + 4);
      let spec: WagonSpec | { kind: 'loco'; speed: number };
      let ambient = 12;
      let speed: () => number;
      if (id.caseId === 'storm') {
        spec = { kind: 'reefer', goods: 'frozen food', setpoint_c: DEMO.storm.setpoint_c, min_c: DEMO.storm.min_c, max_c: DEMO.storm.max_c, grace_s: 10, rate_eur_s: 20, cap_eur: 6000 };
        speed = () => 80;
      } else {
        const c = DEMO.cases[id.caseId];
        ambient = c.ambient_c;
        spec = id.wagon === 'LOCO' ? { kind: 'loco', speed: c.speed_kmh.before } : c.wagons[id.wagon];
        const caseId = id.caseId;
        speed = () => (this.devices.get(`${caseId}/LOCO`)!.model as LocoModel).speed;
      }
      this.devices.set(id.key, new Device(id, spec, ambient, pin, speed, deviceLog));
    });
    onLogs(logs => this.ingest(logs));
    setInterval(() => void this.keeper(), 1_000);
  }

  private dev = (key: string) => this.devices.get(key)!;
  private caseDevices = (c: CaseId | 'storm') => [...this.devices.values()].filter(d => d.id.caseId === c);

  // ---------------------------------------------------------------- chain mirror

  private ingest(logs: DecodedLog[]) {
    for (const log of logs) {
      const e: ChainEvent = { name: log.eventName, args: plain(log.args), tx: log.transactionHash, block: log.blockNumber, at: Date.now() };
      if (e.name !== 'Reading') {
        this.events.push(e);
        if (this.events.length > 400) this.events.shift();
      }
      const m = this.mirrors.get(Number(e.args.shipment));
      if (!m) continue;
      if (e.name === 'Standstill') m.stoppedAt = e.args.stopped ? Date.now() : undefined;
      if (e.name === 'DelayAccrued') Object.assign(m, { delayState: 1, delayAt: Date.now() });
      if (e.name === 'DelayDisputed') m.delayState = 2;
      if (e.name === 'DelayResolved') m.delayState = Number(e.args.state);
      if (e.name === 'Closed') this.mirrors.delete(m.sid);
    }
    if (logs.some(l => l.eventName !== 'Reading')) this.changed();
  }

  private findEvent(pred: (e: ChainEvent) => boolean, since: number) {
    return this.events.find(e => e.at >= since && pred(e));
  }

  // ---------------------------------------------------------------- open shipments survive restarts

  private readOpen(): { sid: number; caseId: CaseId | 'storm' }[] {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')).open ?? [] : [];
  }

  private writeOpen(open: { sid: number; caseId: CaseId | 'storm' }[]) {
    mkdirSync(resolve(RELAYER_DIR, '.state'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ open }, null, 2));
  }

  private async closeShipment(sid: number, caseId: CaseId | 'storm') {
    try {
      await call(this.customers[caseId], this.rail, RAIL.abi, 'close', [sid], `close shipment ${sid}`);
    } catch (e) {
      this.log(`close ${sid}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
    this.mirrors.delete(sid);
    this.writeOpen(this.readOpen().filter(o => o.sid !== sid));
  }

  // ---------------------------------------------------------------- booking

  private async book(caseId: CaseId | 'storm'): Promise<number> {
    const devices = this.caseDevices(caseId);
    const now = Math.floor(Date.now() / 1000);
    let terms;
    let wagons;
    if (caseId === 'storm') {
      wagons = devices.map(d => ({
        device: d.address, kind: 1, tMin: DEMO.storm.min_c * 10, tMax: DEMO.storm.max_c * 10, pMin: 0, shockMax: 0,
        capEur: 6000, rateEur: 20, graceSec: 10, ref: bytes16(`CORRIDOR/${d.id.wagon}`),
      }));
      terms = {
        customer: this.customers.storm.address, bondEur: devices.length * 6000, delayPenaltyEur: 0, liabilityCapEur: 0,
        deadline: now + 86_400, maxStandstill: 86_400, gapAfter: DEMO.gap_after_s, challengeWindow: DEMO.challenge_window_s,
        ref: bytes16('STORM-6100'),
      };
    } else {
      const spec = DEMO.cases[caseId];
      const contract = contractTerms(spec.contract);
      const trainId = trainOf(caseId).train_id;
      let exposure = 0;
      wagons = devices.map(d => {
        const s = d.id.wagon === 'LOCO' ? undefined : spec.wagons[d.id.wagon];
        if (s?.kind === 'reefer') exposure += s.cap_eur;
        return {
          device: d.address,
          kind: KIND_CODE[d.kind],
          tMin: s?.kind === 'reefer' ? Math.round(s.min_c * 10) : 0,
          tMax: s?.kind === 'reefer' ? Math.round(s.max_c * 10) : 0,
          pMin: s?.kind === 'tank' ? Math.round(s.min_bar * 100) : 0,
          shockMax: s?.kind === 'tank' ? Math.round(s.shock_max_g * 100) : 0,
          capEur: s?.kind === 'reefer' ? s.cap_eur : 0,
          rateEur: s?.kind === 'reefer' ? s.rate_eur_s : 0,
          graceSec: s?.kind === 'reefer' ? s.grace_s : 0,
          ref: bytes16(`${trainId}/${d.id.wagon}`),
        };
      });
      terms = {
        customer: this.customers[caseId].address,
        bondEur: exposure + contract.contract_penalty, // the automatic exposure, not the liability cap
        delayPenaltyEur: contract.contract_penalty,
        liabilityCapEur: contract.liability_cap,
        deadline: now + contract.contract_deadline_h * 3600,
        maxStandstill: DEMO.max_standstill_s,
        gapAfter: DEMO.gap_after_s,
        challengeWindow: DEMO.challenge_window_s,
        ref: bytes16(spec.shipment_ref),
      };
    }

    const label = caseId === 'storm' ? 'book storm corridor' : `book ${DEMO.cases[caseId].shipment_ref}`;
    const { logs } = await call(this.carrier, this.rail, RAIL.abi, 'book', [terms, wagons], label);
    const sid = Number(logs.find(l => l.eventName === 'Booked')!.args.shipment);
    for (const l of logs.filter(l => l.eventName === 'WagonRegistered')) {
      const device = devices.find(d => d.address.toLowerCase() === String(l.args.device).toLowerCase());
      if (device) device.wagonId = Number(l.args.wagon);
    }
    this.mirrors.set(sid, { sid, caseId, delayState: 0 });
    this.writeOpen([...this.readOpen(), { sid, caseId }]);
    return sid;
  }

  private async accept(caseId: CaseId | 'storm', sid: number) {
    try {
      await call(this.customers[caseId], this.rail, RAIL.abi, 'accept', [sid], `accept shipment ${sid}`);
    } catch {
      // A device is still bound to a shipment from before a restart: close that one, then retry
      await this.releaseBusy(this.caseDevices(caseId));
      await call(this.customers[caseId], this.rail, RAIL.abi, 'accept', [sid], `accept shipment ${sid}`);
    }
    for (const d of this.caseDevices(caseId)) d.bound = true;
  }

  /** Closes, as its customer, any shipment of ours that still holds one of these devices. */
  private async releaseBusy(devices: Device[]) {
    const ours = new Map(Object.entries(this.customers).map(([c, s]) => [s.address.toLowerCase(), c as CaseId | 'storm']));
    for (const d of devices) {
      const wagonId = Number(await readRail<number>('deviceWagon', [d.address]));
      if (!wagonId) continue;
      const wagon = await readRail<readonly unknown[]>('wagons', [wagonId]);
      const sid = Number(wagon[1]);
      const shipment = await readRail<readonly unknown[]>('shipments', [sid]);
      const owner = ours.get(String(shipment[5]).toLowerCase());
      if (!owner) throw new Error(`${d.id.key} is bound to shipment ${sid} of another customer`);
      this.log(`releasing shipment ${sid} left open before a restart`);
      await this.closeShipment(sid, owner);
    }
  }

  // ---------------------------------------------------------------- controls

  async goLive() {
    if (this.live || this.busy) return;
    this.busy = 'Booking both shipments on chain';
    this.changed();
    try {
      for (const o of this.readOpen()) await this.closeShipment(o.sid, o.caseId);
      for (const c of ['s1', 's3'] as CaseId[]) {
        const spec = DEMO.cases[c];
        for (const d of this.caseDevices(c)) {
          d.reset(spec.ambient_c, { speed: spec.speed_kmh.before });
          d.active = true;
        }
        Object.assign(this.cases[c], { phase: 'normal', steps: [], running: false });
      }
      this.changed();
      const s1 = await this.book('s1');
      const s3 = await this.book('s3');
      this.cases.s1.shipmentId = s1;
      this.cases.s3.shipmentId = s3;
      await Promise.all([this.accept('s1', s1), this.accept('s3', s3)]);
      await this.calibrateGas();
      this.live = true;
      this.log(`live: shipments ${s1} and ${s3} accepted, ${this.caseDevices('s1').length + this.caseDevices('s3').length} devices reporting`);
    } catch (e) {
      this.log(`go live failed: ${e instanceof Error ? e.message : e}`);
      for (const c of ['s1', 's3'] as CaseId[]) this.caseDevices(c).forEach(d => (d.active = false));
      this.cases.s1.phase = this.cases.s3.phase = 'idle';
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  /** Free gas estimates of a plain reading per device kind, before anything is sent. */
  private async calibrateGas() {
    const plain = toHex((-200n & 0xffffn) | ((-205n & 0xffffn) << 16n) | ((-195n & 0xffffn) << 32n) | (420n << 48n) | (5n << 64n), { size: 32 });
    for (const key of ['s1/W02', 's3/W05', 's1/LOCO']) {
      const d = this.dev(key);
      try {
        const data = encodeFunctionData({ abi: RAIL.abi, functionName: 'report', args: [plain] });
        const est = hexToNumber(await rpc.call<Hex>('eth_estimateGas', [{ from: d.address, to: this.rail, data }]));
        const factor = calibrate(d.kind, est);
        this.log(`gas ${d.kind}: plain reading ${est} (${factor > 1.01 ? `limits scaled x${(factor * 1.05).toFixed(2)}` : 'limits fit'})`);
      } catch (e) {
        this.log(`gas calibration ${key} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async reset() {
    if (this.busy) return;
    this.busy = 'Closing shipments';
    this.generation++;
    this.changed();
    try {
      for (const d of this.devices.values()) {
        d.active = false;
        d.bound = false;
        d.forceHz = undefined;
      }
      await sleep(1_500);
      for (const o of this.readOpen()) await this.closeShipment(o.sid, o.caseId);
      for (const c of ['s1', 's3'] as CaseId[]) this.cases[c] = { phase: 'idle', running: false, steps: [] };
      this.storm = { running: false, steps: [] };
      this.live = false;
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  // ---------------------------------------------------------------- timelines

  private async timeline(target: Run, defs: StepDef[]) {
    const gen = this.generation;
    const t0 = Date.now();
    target.running = true;
    target.startedAt = t0;
    target.steps = defs.map(d => ({ id: d.id, label: d.label, status: 'pending' }));
    this.changed();
    let prevDone = t0;
    const until = async (t: number) => {
      while (Date.now() < t) {
        if (gen !== this.generation) return false;
        await sleep(50);
      }
      return gen === this.generation;
    };
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const st = target.steps[i];
      if (d.at !== undefined && !(await until(t0 + d.at * 1000))) return;
      if (d.wait !== undefined && !(await until(prevDone + d.wait * 1000))) return;
      st.status = 'active';
      this.changed();
      try {
        if (d.waitFor) {
          const deadline = Date.now() + (d.timeout ?? 60) * 1000;
          let ev = this.findEvent(d.waitFor, t0);
          while (!ev && Date.now() < deadline) {
            if (gen !== this.generation) return;
            await sleep(80);
            ev = this.findEvent(d.waitFor, t0);
          }
          if (!ev) {
            st.status = 'skipped';
            st.detail = 'not observed in time';
            this.changed();
            prevDone = Date.now();
            continue;
          }
          st.tx = ev.tx;
          st.detail = d.detail?.(ev);
        }
        if (d.run) {
          const r = await d.run();
          if (r) {
            st.tx = r.tx ?? st.tx;
            st.detail = r.detail ?? st.detail;
          }
        }
        st.status = 'done';
      } catch (e) {
        st.status = 'failed';
        st.detail = e instanceof BudgetExhausted ? 'MON spending cap reached' : e instanceof Error ? e.message.split('\n')[0] : String(e);
        this.log(`${d.id}: ${st.detail}`);
      }
      st.atMs = Date.now() - t0;
      prevDone = Date.now();
      this.changed();
    }
    target.running = false;
    this.changed();
  }

  private async anchor(caseId: CaseId) {
    const incident = DEMO.cases[caseId].incident;
    const decision = soteriaDecision(incident);
    if (!decision) throw new Error(`no Soteria decision for ${incident}`);
    const head = pad(`0x${decision.receiptHash}` as Hex, { size: 32 });
    const { hash } = await call(
      this.carrier, this.rail, RAIL.abi, 'anchorDecision',
      [this.cases[caseId].shipmentId, bytes16(incident), head, decision.tier, decision.grants.length],
      `anchor ${incident}`,
    );
    return { tx: hash, detail: `receipt head ${decision.receiptHash}` };
  }

  async runS1() {
    const c = this.cases.s1;
    if (!this.live || c.running || c.phase !== 'normal') return;
    const w02 = this.dev('s1/W02');
    const loco = this.dev('s1/LOCO');
    const is = (name: string, wagon = () => w02.wagonId) => (e: ChainEvent) => e.name === name && e.args.wagon === wagon();
    await this.timeline(c, [
      {
        id: 'impact', label: 'Minor impact with an obstruction ahead of the locomotive', at: 0,
        run: async () => {
          c.phase = 'incident';
          const now = Date.now();
          loco.model.vibration.hit(now, 1.6);
          w02.model.vibration.hit(now + 120, 1.4);
          this.dev('s1/W05').model.vibration.hit(now + 260, 0.5);
          (w02.model as ReeferModel).mode = 'failed';
          (loco.model as LocoModel).target = DEMO.cases.s1.speed_kmh.after;
          this.changed();
        },
      },
      { id: 'unit', label: `W02 refrigeration unit damaged: air warms towards ${DEMO.cases.s1.ambient_c} °C outside`, at: 1 },
      {
        id: 'excursion', label: 'W02 above −15 °C: excursion starts on chain', waitFor: is('ExcursionStarted'),
        detail: e => `${(Number(e.args.temp) / 10).toFixed(1)} °C`,
      },
      { id: 'grace', label: '10 s grace period over: €20 per second accrues', wait: 10 },
      { id: 'soteria', label: 'Soteria decides: Cool cargo (tier 1, autonomous), anchored on chain', at: 26, run: () => this.anchor('s1') },
      {
        id: 'backup', label: 'Crew switches W02 to backup cooling', wait: 2,
        run: async () => {
          (w02.model as ReeferModel).mode = 'backup';
        },
      },
      {
        id: 'settled', label: 'W02 back below −15 °C: Frischemarkt compensated automatically', waitFor: is('ExcursionEnded'), timeout: 90,
        detail: e => `${e.args.secondsOut} s out of range, €${Number(e.args.paidEur).toLocaleString('en-US')} paid`,
      },
    ]);
  }

  async runS3() {
    const c = this.cases.s3;
    if (!this.live || c.running || c.phase !== 'normal') return;
    const sid = () => c.shipmentId;
    const w02 = this.dev('s3/W02');
    const w05 = this.dev('s3/W05');
    const loco = this.dev('s3/LOCO');
    const claim = DEMO.cases.s3.damage_claim!;
    let settlementId: number | undefined;
    await this.timeline(c, [
      {
        id: 'tree', label: 'Storm-felled tree brings down the overhead line: emergency stop', at: 0,
        run: async () => {
          c.phase = 'incident';
          const now = Date.now();
          (loco.model as LocoModel).emergencyStop();
          loco.model.vibration.hit(now, 3.2);
          w02.model.vibration.hit(now + 90, 2.9);
          this.dev('s3/W04').model.vibration.hit(now + 150, 2.3);
          w05.model.vibration.hit(now + 200, 2.6);
          this.dev('s3/W07').model.vibration.hit(now + 280, 1.7);
          (w02.model as ReeferModel).mode = 'breached';
          (w05.model as TankModel).leaking = true;
          this.changed();
        },
      },
      {
        id: 'shock', label: 'Hazmat W05: impact above 2.0 g, safety alert on chain',
        waitFor: e => e.name === 'SafetyAlert' && e.args.wagon === w05.wagonId && e.args.code === 1,
        detail: e => `${(Number(e.args.value) / 100).toFixed(2)} g`,
      },
      { id: 'stop', label: 'Locomotive reports standstill', waitFor: e => e.name === 'Standstill' && e.args.shipment === sid() && e.args.stopped === true },
      {
        id: 'pharma', label: 'Pharma W02: cooling unit torn off, above +8 °C, excursion on chain',
        waitFor: e => e.name === 'ExcursionStarted' && e.args.wagon === w02.wagonId,
        detail: e => `${(Number(e.args.temp) / 10).toFixed(1)} °C`,
      },
      {
        id: 'pressure', label: 'Hazmat W05: tank pressure below 3.8 bar, safety alert on chain',
        waitFor: e => e.name === 'SafetyAlert' && e.args.wagon === w05.wagonId && e.args.code === 2,
        detail: e => `${(Number(e.args.value) / 100).toFixed(2)} bar`,
      },
      { id: 'soteria', label: 'Soteria: Stop train + Notify authority (tier 3, 2 human keys), anchored on chain', at: 18, run: () => this.anchor('s3') },
      {
        id: 'delay', label: `Standstill beyond ${DEMO.max_standstill_s} s: delivery slot lost, €9,000 delay penalty accrues`,
        waitFor: e => e.name === 'DelayAccrued' && e.args.shipment === sid(), timeout: 60,
        detail: e => `challenge window until ${new Date(Number(e.args.challengeUntil) * 1000).toLocaleTimeString('en-GB')}`,
      },
      {
        id: 'dispute', label: 'Carrier disputes in the challenge window: force majeure (storm)', wait: 4,
        run: async () => {
          const reason = stringToHex('force majeure: storm-felled tree', { size: 32 });
          const { hash } = await call(this.carrier, this.rail, RAIL.abi, 'disputeDelay', [sid(), reason], 'dispute delay');
          return { tx: hash, detail: 'penalty frozen until both parties sign' };
        },
      },
      {
        id: 'claim', label: `Soteria damage assessment ${claim.wagon} (general goods, no sensor): €${claim.amount_eur.toLocaleString('en-US')}, delay waived`, wait: 4,
        run: async () => {
          const head = pad(`0x${soteriaDecision(DEMO.cases.s3.incident)!.receiptHash}` as Hex, { size: 32 });
          const trainId = trainOf('s3').train_id;
          const { hash, logs } = await call(
            this.carrier, this.rail, RAIL.abi, 'proposeSettlement',
            [sid(), claim.amount_eur, true, bytes16(`${trainId}/${claim.wagon}`), head],
            'propose settlement',
          );
          settlementId = Number(logs.find(l => l.eventName === 'SettlementProposed')!.args.settlement);
          return { tx: hash, detail: 'signed by the carrier' };
        },
      },
      {
        id: 'sign', label: 'Chemiewerk signs: paid from the carrier liability pool', wait: 5,
        run: async () => {
          const { hash } = await call(this.customers.s3, this.rail, RAIL.abi, 'sign', [settlementId], 'customer signs');
          return { tx: hash, detail: `€${claim.amount_eur.toLocaleString('en-US')} paid, delay waived` };
        },
      },
      {
        id: 'cap', label: 'Pharma W02 reaches its €12,000 cap: paid automatically',
        waitFor: e => e.name === 'ExcursionEnded' && e.args.wagon === w02.wagonId, timeout: 120,
        detail: e => `€${Number(e.args.paidEur).toLocaleString('en-US')} after ${e.args.secondsOut} s out of range`,
      },
    ]);
  }

  async runStorm() {
    const s = this.storm;
    if (!this.live || s.running) return;
    const devices = this.caseDevices('storm');
    await this.timeline(s, [
      { id: 'warn', label: 'Storm warning for the Berlin–Hamburg corridor', at: 0 },
      {
        id: 'book', label: `${devices.length} monitored wagons on the corridor, booked in one transaction`,
        run: async () => {
          for (const d of devices) d.reset(12);
          const sid = await this.book('storm');
          s.shipmentId = sid;
          await this.accept('storm', sid);
          return { detail: `shipment ${sid}` };
        },
      },
      {
        id: 'burst', label: `All ${devices.length} wagons switch to 1 Hz at once`,
        run: async () => {
          for (const d of devices) {
            d.storm = 1;
            d.forceHz = 1;
            d.active = true;
          }
        },
      },
      {
        id: 'hold', label: `${DEMO.storm.seconds} s of storm: about ${devices.length * DEMO.storm.seconds} readings on chain`, wait: DEMO.storm.seconds,
        run: async () => {
          const sent = devices.reduce((n, d) => n + d.sent, 0);
          for (const d of devices) {
            d.active = false;
            d.forceHz = undefined;
            d.storm = 0;
          }
          return { detail: `${sent} readings sent by storm wagons` };
        },
      },
      {
        id: 'close', label: 'Storm has passed: corridor shipment closed, bond returned', wait: 2,
        run: async () => {
          if (s.shipmentId) await this.closeShipment(s.shipmentId, 'storm');
          for (const d of devices) d.bound = false;
        },
      },
    ]);
  }

  // ---------------------------------------------------------------- keeper

  /** Only time has passed: someone has to call the contract. Here the customer does. */
  private async keeper() {
    if (budget.exhausted) return;
    for (const m of this.mirrors.values()) {
      if (m.working || m.caseId === 'storm') continue;
      const customer = this.customers[m.caseId];
      const now = Date.now();
      try {
        if (m.delayState === 0 && m.stoppedAt && now > m.stoppedAt + (DEMO.max_standstill_s + 1.5) * 1000) {
          m.working = true;
          await call(customer, this.rail, RAIL.abi, 'flagDelay', [m.sid], `flag delay ${m.sid}`);
        } else if (m.delayState === 1 && m.delayAt && now > m.delayAt + (DEMO.challenge_window_s + 1.5) * 1000) {
          m.working = true;
          await call(customer, this.rail, RAIL.abi, 'settleDelay', [m.sid], `settle delay ${m.sid}`);
        }
      } catch {
        // estimateGas refused (too early or already done): nothing was sent, retry next second
      } finally {
        m.working = false;
      }
    }
    // A monitored device that fell silent counts as out of range
    for (const d of this.devices.values()) {
      if (!d.bound || d.id.caseId === 'storm' || d.kind !== 'reefer' || !d.lastTx || d.wagonId === undefined) continue;
      const m = [...this.mirrors.values()].find(x => x.caseId === d.id.caseId);
      if (!m || m.working) continue;
      if (Date.now() - d.lastTx.at > (DEMO.gap_after_s + 3) * 1000) {
        m.working = true;
        try {
          await call(this.customers[d.id.caseId as CaseId], this.rail, RAIL.abi, 'checkGap', [d.wagonId], `gap ${d.id.key}`);
          d.lastTx.at = Date.now();
        } catch {
          // not due yet
        } finally {
          m.working = false;
        }
      }
    }
  }

  // ---------------------------------------------------------------- dashboard snapshot

  snapshot() {
    return {
      network: NETWORK.name,
      live: this.live,
      busy: this.busy ?? null,
      sendMode: sendMode(),
      budget: budget.snapshot(),
      cases: this.cases,
      storm: this.storm,
      devices: [...this.devices.values()].map(d => ({
        key: d.id.key,
        caseId: d.id.caseId,
        wagon: d.id.wagon,
        kind: d.kind,
        goods: d.goods,
        address: d.address,
        limits: d.limits,
        wagonId: d.wagonId ?? null,
        bound: d.bound,
        active: d.active,
        sent: d.sent,
        halted: d.halted ?? null,
      })),
      events: this.events.slice(-80),
    };
  }
}
