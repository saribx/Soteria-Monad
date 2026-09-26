import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { DEMO, type WagonSpec } from './config.js';
import { BudgetExhausted, RAIL, Sender, TxReverted, onLogs } from './chain.js';
import { deviceAccount, type DeviceId } from './keys.js';
import { LocoModel, ReeferModel, TankModel, type Sample } from './physics.js';

export type Kind = 'reefer' | 'tank' | 'loco';
export const KIND_CODE: Record<Kind, number> = { reefer: 1, tank: 2, loco: 3 };

const FLAG_ARRIVED = 1;
const FLAG_STOPPED = 2;

// Gas limit per reading. Monad charges the limit, not the gas used, so each
// path gets its own measured limit (gas used on Monad Foundry's anvil, +~10%):
//   reefer in range 52.1k · excursion open 60.8k · excursion settles 137.7k
//   tank 60.3k · tank alert 62.0k · locomotive 60.3k · standstill change 64.7k
export const GAS = {
  reefer: { rest: 58_000n, excursion: 67_000n, settle: 152_000n },
  tank: { rest: 67_000n, alert: 72_000n },
  loco: { rest: 67_000n, change: 75_000n },
};

// Gas a plain reading used where the limits above were measured. On a network
// with other storage pricing (MIP-8 on mainnet) `calibrate` scales the limits
// from a free eth_estimateGas before the first reading is sent.
const MEASURED_PLAIN: Record<Kind, number> = { reefer: 52_148, tank: 60_272, loco: 60_288 };

function scale(kind: Kind, factor: number) {
  const limits = GAS[kind] as Record<string, bigint>;
  for (const k of Object.keys(limits)) limits[k] = BigInt(Math.ceil((Number(limits[k]) * factor) / 1000) * 1000);
}

/** Scales a kind's limits up (never down) so a plain reading of `estimate` gas fits. */
export function calibrate(kind: Kind, estimate: number): number {
  const factor = estimate / MEASURED_PLAIN[kind];
  if (factor > 1.01) {
    scale(kind, factor * 1.05);
    MEASURED_PLAIN[kind] = estimate;
  }
  return factor;
}

export interface Limits {
  minC?: number;
  maxC?: number;
  minBar?: number;
  shockMaxG?: number;
  graceS?: number;
  rateEur?: number;
  capEur?: number;
}

interface Window {
  tMin: number;
  tMax: number;
  tLast: number;
  pMin: number;
  shock: number;
  speed: number;
  startedAt: number;
}

const freshWindow = (now: number): Window => ({
  tMin: Infinity,
  tMax: -Infinity,
  tLast: 0,
  pMin: Infinity,
  shock: 0,
  speed: 0,
  startedAt: now,
});

const i16 = (v: number) => BigInt(Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff);
const u16 = (v: number) => BigInt(Math.max(0, Math.min(65535, Math.round(v))));

export type DeviceLog = (device: Device, message: string) => void;

export class Device {
  readonly sender: Sender;
  readonly model: ReeferModel | TankModel | LocoModel;
  readonly kind: Kind;
  readonly limits: Limits;
  readonly goods: string;

  active = false; // sampling, visible on the dashboard
  bound = false; // accepted on chain: readings count
  wagonId?: number; // id in SoteriaRail
  storm = 0;
  forceHz?: number;
  arrived = false;
  inflight = false;
  lastSample?: Sample;
  lastTx?: { hash: Hex; at: number; latencyMs: number; block: number };
  sent = 0;
  halted?: string;

  private win: Window = freshWindow(Date.now());
  private lastSentAt = 0;
  private escalatedUntil = 0;
  private lastOut = false;
  private lastStopped = false;
  private alerted = { shock: false, pressure: false };
  // The wagon's excursion as the chain sees it, from receipts: decides whether
  // the next reading may settle (and needs the larger gas limit).
  private onChain = { open: false, since: 0, paid: 0, capped: false };

  constructor(
    readonly id: DeviceId,
    spec: WagonSpec | { kind: 'loco'; speed: number },
    ambient: number,
    pin: number,
    private speedOfTrain: () => number,
    private log: DeviceLog,
  ) {
    this.sender = new Sender(deviceAccount(id.key), pin, id.key);
    onLogs(logs => {
      for (const l of logs) {
        if (this.wagonId === undefined || Number(l.args.wagon) !== this.wagonId) continue;
        if (l.eventName === 'ExcursionStarted') Object.assign(this.onChain, { open: true, since: Date.now() });
        if (l.eventName === 'ExcursionEnded') {
          this.onChain.open = false;
          this.onChain.paid += Number(l.args.paidEur);
          if (l.args.capped) this.onChain.capped = true;
        }
      }
    });
    if (spec.kind === 'reefer') {
      this.kind = 'reefer';
      this.model = new ReeferModel(spec.setpoint_c, ambient);
      this.limits = { minC: spec.min_c, maxC: spec.max_c, graceS: spec.grace_s, rateEur: spec.rate_eur_s, capEur: spec.cap_eur };
      this.goods = spec.goods;
    } else if (spec.kind === 'tank') {
      this.kind = 'tank';
      this.model = new TankModel(spec.pressure_bar, ambient);
      this.limits = { minBar: spec.min_bar, shockMaxG: spec.shock_max_g };
      this.goods = spec.goods;
    } else {
      this.kind = 'loco';
      this.model = new LocoModel(spec.speed);
      this.limits = {};
      this.goods = 'locomotive';
    }
  }

  get address(): Address {
    return this.sender.address;
  }

  get escalated(): boolean {
    return this.forceHz !== undefined || Date.now() < this.escalatedUntil;
  }

  /** Resets the device state for a new run (keeps the key and its nonce). */
  reset(ambient: number, spec?: { setpoint?: number; speed?: number }) {
    if (this.model instanceof ReeferModel) {
      this.model.mode = 'running';
      this.model.ambient = ambient;
      this.model.temp = (spec?.setpoint ?? this.model.setpoint) + (Math.random() - 0.5) * 0.4;
    } else if (this.model instanceof TankModel) {
      this.model.leaking = false;
      this.model.pressure = this.model.nominalBar;
      this.model.ambient = ambient;
    } else if (spec?.speed !== undefined) {
      this.model.speed = spec.speed;
      this.model.target = spec.speed;
      this.model.decel = 0.6;
    }
    this.win = freshWindow(Date.now());
    this.escalatedUntil = 0;
    this.lastOut = false;
    this.lastStopped = false;
    this.alerted = { shock: false, pressure: false };
    this.onChain = { open: false, since: 0, paid: 0, capped: false };
    this.arrived = false;
    this.storm = 0;
    this.forceHz = undefined;
    this.halted = undefined;
    this.bound = false;
    this.wagonId = undefined;
  }

  escalate(forMs = DEMO.calm_s * 1000) {
    this.escalatedUntil = Math.max(this.escalatedUntil, Date.now() + forMs);
  }

  tick(now: number, dt: number): Sample | undefined {
    if (!this.active) return undefined;
    const s = this.model.step(now, dt, this.speedOfTrain(), this.storm);
    this.lastSample = s;
    const w = this.win;
    w.tMin = Math.min(w.tMin, s.temp);
    w.tMax = Math.max(w.tMax, s.temp);
    w.tLast = s.temp;
    w.pMin = Math.min(w.pMin, s.pressure);
    w.shock = Math.max(w.shock, s.shock);
    w.speed = s.speed;

    let immediate = false;
    if (s.shock > 1.0) this.escalate();
    if (this.kind === 'reefer') {
      const { minC = -99, maxC = 99 } = this.limits;
      // 1 Hz only while it can still change money: approaching, or out and not capped
      if ((s.temp > maxC - 1 || s.temp < minC + 1) && !this.onChain.capped) this.escalate();
      const out = w.tMax > maxC || w.tMin < minC;
      if (out !== this.lastOut) immediate = true;
    } else if (this.kind === 'tank') {
      const { minBar = 0, shockMaxG = 99 } = this.limits;
      if (s.pressure < minBar + 0.15 && !this.alerted.pressure) this.escalate();
      if (s.shock > shockMaxG && !this.alerted.shock) immediate = true;
      if (s.pressure < minBar && !this.alerted.pressure) immediate = true;
    } else {
      const stopped = s.speed < 0.5 && !this.arrived;
      if (stopped !== this.lastStopped) {
        immediate = true;
        this.escalate();
      }
    }

    const period = this.forceHz
      ? 1000 / this.forceHz
      : now < this.escalatedUntil
        ? 1000 / DEMO.escalated_hz
        : DEMO.heartbeat_s * 1000;
    if (this.bound && !this.inflight && !this.halted && (immediate || now - this.lastSentAt >= period)) {
      void this.flush(now);
    }
    return s;
  }

  private async flush(now: number) {
    const w = this.win;
    this.win = freshWindow(now);
    this.lastSentAt = now;
    this.inflight = true;

    let flags = 0;
    let gas: bigint;
    if (this.kind === 'reefer') {
      const { minC = -99, maxC = 99, graceS = 0, rateEur = 0, capEur = 0 } = this.limits;
      const out = w.tMax > maxC || w.tMin < minC;
      this.lastOut = out;
      const c = this.onChain;
      const accrued = Math.max(0, (now - c.since) / 1000 - graceS) * rateEur;
      const nearCap = accrued + 3 * rateEur >= capEur - c.paid;
      gas = c.open && (!out || nearCap) ? GAS.reefer.settle : out && !c.capped ? GAS.reefer.excursion : GAS.reefer.rest;
    } else if (this.kind === 'tank') {
      const { minBar = 0, shockMaxG = 99 } = this.limits;
      gas = GAS.tank.rest;
      if (w.shock > shockMaxG && !this.alerted.shock) {
        this.alerted.shock = true;
        gas = GAS.tank.alert;
      }
      if (w.pMin < minBar && !this.alerted.pressure) {
        this.alerted.pressure = true;
        gas = GAS.tank.alert;
      }
    } else {
      const stopped = w.speed < 0.5 && !this.arrived;
      if (stopped) flags |= FLAG_STOPPED;
      if (this.arrived) flags |= FLAG_ARRIVED;
      gas = stopped !== this.lastStopped || this.arrived ? GAS.loco.change : GAS.loco.rest;
      this.lastStopped = stopped;
    }

    const temp = this.kind === 'loco' ? 0 : w.tLast;
    const packed =
      i16(temp * 10) |
      (i16((this.kind === 'loco' ? 0 : w.tMin) * 10) << 16n) |
      (i16((this.kind === 'loco' ? 0 : w.tMax) * 10) << 32n) |
      (u16((this.kind === 'tank' ? w.pMin : 0) * 100) << 48n) |
      (u16(w.shock * 100) << 64n) |
      (u16(w.speed * 10) << 80n) |
      (BigInt(flags) << 96n) |
      (u16(((now - w.startedAt) / 1000) * 10) << 104n);
    const data = encodeFunctionData({ abi: RAIL.abi, functionName: 'report', args: [toHex(packed, { size: 32 })] });

    try {
      const { hash, receipt, latencyMs } = await this.sender.send(
        railAddress(),
        data,
        gas,
        `report ${this.id.key}`,
      );
      this.sent++;
      this.lastTx = { hash, at: Date.now(), latencyMs, block: Number(BigInt(receipt.blockNumber)) };
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        this.halted = 'budget';
        this.log(this, e.message);
      } else if (e instanceof TxReverted && e.gasUsed >= Number(e.gasLimit) * 0.97) {
        // ran out of gas: the next reading of this kind gets 30% more
        scale(this.kind, 1.3);
        this.log(this, `out of gas at ${e.gasUsed}, ${this.kind} limits raised by 30%`);
      } else {
        this.log(this, `reading failed: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      this.inflight = false;
    }
  }
}

let rail: Address | undefined;
export const setDeviceRail = (a: Address) => (rail = a);
const railAddress = () => {
  if (!rail) throw new Error('rail address not set');
  return rail;
};

