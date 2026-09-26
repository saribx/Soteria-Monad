import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  hexToBigInt,
  hexToNumber,
  keccak256,
  parseEther,
  parseGwei,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { NETWORK, ROOT, SPEND_CAP_MON, type Endpoint } from './config.js';

// ---------------------------------------------------------------- artifacts

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(ROOT, `contracts/out/${name}.sol/${name}.json`);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: file.abi, bytecode: file.bytecode.object };
}

export const RAIL = artifact('SoteriaRail');
export const TEUR = artifact('TEUR');

// ---------------------------------------------------------------- JSON-RPC pool

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

interface Slot extends Endpoint {
  tokens: number;
  last: number;
  downUntil: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Spreads calls over the public endpoints and never exceeds their rate limits
 * (token bucket per endpoint). A sender can be pinned to one endpoint so its
 * transactions arrive in nonce order.
 */
class RpcPool {
  private slots: Slot[] = NETWORK.rpc.map(e => ({ ...e, tokens: e.rps, last: Date.now(), downUntil: 0 }));
  private weighted: number[] = this.slots.flatMap((s, i) => Array(Math.max(1, Math.round(s.rps))).fill(i));
  private next = 0;
  private id = 0;

  /** Endpoint index for the n-th sender, proportional to the endpoints' limits. */
  pinFor(n: number): number {
    return this.weighted[(n * 7) % this.weighted.length];
  }

  async call<T = unknown>(method: string, params: unknown[], pin?: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const slot = await this.acquire(attempt === 0 ? pin : undefined);
      try {
        const res = await fetch(slot.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(method === 'eth_sendRawTransactionSync' ? 12_000 : 8_000),
        });
        if (res.status === 429) {
          slot.downUntil = Date.now() + 1_000;
          lastError = new Error(`429 from ${slot.url}`);
          continue;
        }
        const body = await res.json();
        if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.data);
        return body.result as T;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        slot.downUntil = Date.now() + 2_000;
        lastError = e;
      }
    }
    throw lastError;
  }

  private async acquire(pin?: number): Promise<Slot> {
    for (;;) {
      const now = Date.now();
      for (const s of this.slots) {
        s.tokens = Math.min(s.rps, s.tokens + ((now - s.last) / 1000) * s.rps);
        s.last = now;
      }
      if (pin !== undefined) {
        const s = this.slots[pin % this.slots.length];
        if (s.downUntil <= now && s.tokens >= 1) {
          s.tokens -= 1;
          return s;
        }
        if (s.downUntil > now) pin = undefined; // endpoint is struggling: take any
      }
      if (pin === undefined) {
        for (let k = 0; k < this.slots.length; k++) {
          const s = this.slots[(this.next + k) % this.slots.length];
          if (s.downUntil <= now && s.tokens >= 1) {
            s.tokens -= 1;
            this.next = (this.next + k + 1) % this.slots.length;
            return s;
          }
        }
      }
      await sleep(8);
    }
  }
}

export const rpc = new RpcPool();

// ---------------------------------------------------------------- fees and budget

export const fees = {
  base: parseGwei('100'), // Monad's minimum base fee, refreshed from the chain
  priority: parseGwei('1'),
  get maxFee() {
    return this.base * 2n + this.priority;
  },
  get price() {
    return this.base + this.priority;
  },
};

export async function refreshFees(): Promise<void> {
  try {
    const block = await rpc.call<{ baseFeePerGas?: Hex }>('eth_getBlockByNumber', ['latest', false]);
    if (block?.baseFeePerGas) fees.base = hexToBigInt(block.baseFeePerGas);
  } catch {
    // keep the last known value
  }
}

/** Monad charges the gas limit, so the budget counts gas limit x price. */
export const budget = {
  capWei: parseEther(String(SPEND_CAP_MON)),
  spentWei: 0n,
  txs: 0,
  reverted: 0,
  exhausted: false,
  snapshot() {
    return {
      capMon: Number(formatEther(this.capWei)),
      spentMon: Number(formatEther(this.spentWei)),
      txs: this.txs,
      reverted: this.reverted,
      exhausted: this.exhausted,
    };
  },
};

export class TxReverted extends Error {
  constructor(
    message: string,
    public gasUsed: number,
    public gasLimit: bigint,
  ) {
    super(message);
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super(`MON spending cap of ${SPEND_CAP_MON} reached, relayer stops sending`);
  }
}

// ---------------------------------------------------------------- transactions

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export interface Receipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  contractAddress?: Address | null;
  logs: RpcLog[];
}

export interface TxEvent {
  hash: Hex;
  label: string;
  from: Address;
  device?: string;
  sentAt: number;
  receiptAt?: number;
  latencyMs?: number;
  block?: number;
  ok?: boolean;
  gas?: number;
  error?: string;
}

type TxListener = (tx: TxEvent) => void;
type LogListener = (logs: DecodedLog[]) => void;
const txListeners: TxListener[] = [];
const logListeners: LogListener[] = [];
export const onTx = (fn: TxListener) => txListeners.push(fn);
export const onLogs = (fn: LogListener) => logListeners.push(fn);
const emitTx = (tx: TxEvent) => txListeners.forEach(fn => fn(tx));

export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  transactionHash: Hex;
  blockNumber: number;
}

let railAddress: Address | undefined;
export const setRailAddress = (a: Address) => (railAddress = a);

export function decodeLogs(logs: RpcLog[]): DecodedLog[] {
  const out: DecodedLog[] = [];
  for (const log of logs) {
    if (!railAddress || log.address.toLowerCase() !== railAddress.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: RAIL.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({
        eventName: String(d.eventName),
        args: (d.args ?? {}) as Record<string, unknown>,
        address: log.address,
        transactionHash: log.transactionHash,
        blockNumber: hexToNumber(log.blockNumber),
      });
    } catch {
      // not ours
    }
  }
  return out;
}

/** `eth_sendRawTransactionSync` returns the receipt directly; we fall back to polling if a node lacks it. */
const mode = { sync: true };
export const sendMode = () => (mode.sync ? 'eth_sendRawTransactionSync' : 'eth_sendRawTransaction + receipt polling');

async function waitReceipt(hash: Hex, pin?: number): Promise<Receipt> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const r = await rpc.call<Receipt | null>('eth_getTransactionReceipt', [hash], pin);
    if (r) return r;
    await sleep(150);
  }
  throw new Error(`no receipt for ${hash} after 30 s`);
}

const isUnsupported = (e: unknown) =>
  e instanceof RpcError && (e.code === -32601 || /not (supported|found|available)|unsupported/i.test(e.message));

export class Sender {
  private nonce: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    public account: PrivateKeyAccount,
    public pin: number,
    public device?: string,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  /** Sends one transaction; calls from the same sender are serialised. */
  send(to: Address | undefined, data: Hex, gas: bigint, label: string, value = 0n): Promise<{ hash: Hex; receipt: Receipt; latencyMs: number }> {
    const run = this.queue.then(() => this.sendNow(to, data, gas, label, value));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(to: Address | undefined, data: Hex, gas: bigint, label: string, value: bigint) {
    const price = fees.price;
    if (budget.spentWei + gas * price > budget.capWei) {
      budget.exhausted = true;
      throw new BudgetExhausted();
    }
    if (this.nonce === null) {
      this.nonce = hexToNumber(await rpc.call<Hex>('eth_getTransactionCount', [this.address, 'pending'], this.pin));
    }
    const nonce = this.nonce;
    const serialized = await this.account.signTransaction({
      chainId: NETWORK.chainId,
      type: 'eip1559',
      to,
      data,
      value,
      gas,
      nonce,
      maxFeePerGas: fees.maxFee,
      maxPriorityFeePerGas: fees.priority,
    });
    this.nonce = nonce + 1;
    const hash = keccak256(serialized);
    const tx: TxEvent = { hash, label, from: this.address, device: this.device, sentAt: Date.now() };
    emitTx(tx);

    try {
      let receipt: Receipt | undefined;
      if (mode.sync) {
        try {
          receipt = await rpc.call<Receipt>('eth_sendRawTransactionSync', [serialized], this.pin);
        } catch (e) {
          if (!isUnsupported(e)) throw e;
          mode.sync = false;
        }
      }
      if (!receipt) {
        await rpc.call('eth_sendRawTransaction', [serialized], this.pin);
        receipt = await waitReceipt(hash, this.pin);
      }
      const receiptAt = Date.now();
      budget.spentWei += gas * (receipt.effectiveGasPrice ? hexToBigInt(receipt.effectiveGasPrice) : price);
      budget.txs++;
      const ok = receipt.status === '0x1';
      if (!ok) budget.reverted++;
      Object.assign(tx, {
        receiptAt,
        latencyMs: receiptAt - tx.sentAt,
        block: hexToNumber(receipt.blockNumber),
        ok,
        gas: hexToNumber(receipt.gasUsed),
      });
      emitTx(tx);
      const logs = decodeLogs(receipt.logs ?? []);
      if (logs.length) logListeners.forEach(fn => fn(logs));
      if (!ok) throw new TxReverted(`${label} reverted in block ${tx.block}`, tx.gas!, gas);
      return { hash, receipt, latencyMs: tx.latencyMs! };
    } catch (e) {
      this.nonce = null; // re-read from the chain on the next send
      if (tx.ok === undefined) {
        tx.ok = false;
        tx.error = e instanceof Error ? e.message : String(e);
        emitTx(tx);
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- contract calls

/** Simulates first (a reverted transaction on Monad still pays its gas limit), then sends. */
export async function call(
  sender: Sender,
  to: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  label: string,
): Promise<{ hash: Hex; receipt: Receipt; latencyMs: number; logs: DecodedLog[] }> {
  const data = encodeFunctionData({ abi, functionName, args });
  const estimate = await rpc.call<Hex>('eth_estimateGas', [{ from: sender.address, to, data }], sender.pin);
  const gas = (hexToBigInt(estimate) * 13n) / 10n + 10_000n;
  const result = await sender.send(to, data, gas, label);
  return { ...result, logs: decodeLogs(result.receipt.logs ?? []) };
}

export async function deploy(sender: Sender, art: { abi: Abi; bytecode: Hex }, args: unknown[], label: string): Promise<Address> {
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
  const estimate = await rpc.call<Hex>('eth_estimateGas', [{ from: sender.address, data }]);
  const gas = (hexToBigInt(estimate) * 12n) / 10n;
  const { receipt } = await sender.send(undefined, data, gas, label);
  if (!receipt.contractAddress) throw new Error(`${label}: no contract address`);
  return receipt.contractAddress;
}

export async function balanceOf(address: Address): Promise<bigint> {
  return hexToBigInt(await rpc.call<Hex>('eth_getBalance', [address, 'latest']));
}

export async function readRail<T>(functionName: string, args: unknown[]): Promise<T> {
  const { decodeFunctionResult } = await import('viem');
  const data = encodeFunctionData({ abi: RAIL.abi, functionName, args });
  const result = await rpc.call<Hex>('eth_call', [{ to: railAddress, data }, 'latest']);
  return decodeFunctionResult({ abi: RAIL.abi, functionName, data: result }) as T;
}
