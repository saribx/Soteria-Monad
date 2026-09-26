// One round of the sensor demo, run on the server: every active sensor contract gets one on-chain reading
// at the same moment (every SAMPLE_EVERY-th sample of a simulated 4 Hz stream; a breach goes on-chain at once).
// Sensor VALUES are simulated; the transactions, contract checks and payouts are real.
// Env: SENSOR_GATEWAY_KEY (the contracts' oracle, pays gas), RPC_URL, SENSOR_MIN_MON (refuse below, default 0.3)
import {
  createPublicClient, decodeEventLog, defineChain, encodeFunctionData, formatEther, http, parseAbi, parseEther,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { roundRobin, TESTNET_RPCS } from "./rpc.js";
import dep from "../../src/sensors/deployment.json" with { type: "json" };

export const SENSOR_ABI = parseAbi([
  "function report(int32 value)",
  "function state() view returns (uint8)",
  "function breachStart() view returns (uint40)",
  "event Compensation(bytes32 indexed caseId, address indexed customer, uint256 amount, uint40 secondsPaid, uint256 totalPaid)",
  "event Reading(bytes32 indexed caseId, int32 value)",
  "event Triggered(bytes32 indexed caseId, int32 value, int32 limit, address carrier, address customer, uint256 amount)",
]);

type Tpl = { caseId: string; trigger: number; limit: number; center: number; spread: number; breach: number; graceS: number };
const HOT_GAS = 160_000n;
export type RoundResult =
  | {
      ok: true;
      sent: number;
      confirmed: number;
      failed: number;
      samplesOffChain: number;
      blocks: string[];
      maxPerBlock: number;
      p50ms: number;
      totalMs: number;
      triggered: { caseId: string; value: number; hash: Hex; block: string }[];
      payments: { caseId: string; amountWei: string; seconds: number; hash: Hex }[];
      hashes: Hex[];
      gatewayMon: string;
    }
  | { ok: false; error: string };

const SAMPLE_EVERY = 10;
const MAX_TX_PER_ROUND = 40;
let lastRun = 0;

export async function runRound(env: Record<string, string | undefined>, triggerCaseId?: string): Promise<RoundResult> {
  const key = env.SENSOR_GATEWAY_KEY as Hex | undefined;
  if (!key) return { ok: false, error: "SENSOR_GATEWAY_KEY is not set on the server" };
  if (Date.now() - lastRun < 4000) return { ok: false, error: "a round is already running or just ran; try again in a few seconds" };
  lastRun = Date.now();

  const urls = (env.RPC_URLS ?? env.RPC_URL ?? TESTNET_RPCS.join(",")).split(",");
  const chain = defineChain({ id: 10143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [urls[0]] } } });
  const pub = createPublicClient({ chain, transport: urls.length > 1 ? roundRobin(urls) : http(urls[0]) });
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== dep.oracle.toLowerCase()) return { ok: false, error: "SENSOR_GATEWAY_KEY is not the contracts' oracle" };

  const balance = await pub.getBalance({ address: account.address });
  const minMon = parseEther(env.SENSOR_MIN_MON ?? "0.3");
  if (balance < minMon) return { ok: false, error: `gateway balance ${formatEther(balance)} MON is below the ${formatEther(minMon)} MON floor` };

  const tpls = new Map<string, Tpl>((dep.templates as Tpl[]).map((t) => [t.caseId, t]));
  const active = dep.copies.slice(0, MAX_TX_PER_ROUND);
  if (triggerCaseId && !active.some((c) => c.caseId === triggerCaseId)) return { ok: false, error: `unknown condition ${triggerCaseId}` };
  // out of limits only when the caller says so (the page sends the trigger for the hot rounds). Deciding it from an
  // on-chain read was unreliable: public RPCs lag each other by seconds and returned a stale breachStart of 0.
  const hotSet = new Set(active.filter((c) => c.caseId === triggerCaseId).map((c) => c.address));

  const fees = await pub.estimateFeesPerGas();
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  // gas limit per call: Monad charges the limit, so estimate once per condition and add 20 %
  const gas = new Map<string, bigint>();
  let samples = 0;
  const jobs: { raw: Hex; caseId: string; value: number }[] = [];
  for (const c of active) {
    const t = tpls.get(c.caseId)!;
    const heat = hotSet.has(c.address);
    const window = Array.from({ length: SAMPLE_EVERY }, () =>
      heat ? t.breach + Math.round(Math.random() * 3) * (t.trigger === 1 ? 1 : -1) : Math.round(t.center + (Math.random() * 2 - 1) * t.spread),
    );
    samples += window.length;
    const value = window[window.length - 1];
    let g = gas.get(c.address);
    if (!g) {
      g = heat ? HOT_GAS : ((await pub.estimateContractGas({ address: c.address as Address, abi: SENSOR_ABI, functionName: "report", args: [value], account })) * 125n) / 100n;
      if (!heat) gas.set(c.address, g);
    }
    const raw = await account.signTransaction({
      chainId: chain.id, type: "eip1559", to: c.address as Address, nonce: nonce++, gas: g,
      maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
      data: encodeFunctionData({ abi: SENSOR_ABI, functionName: "report", args: [value] }),
    });
    jobs.push({ raw, caseId: c.caseId, value });
  }

  const t0 = Date.now();
  const fromBlock = await pub.getBlockNumber();
  const sentAt = new Map<Hex, number>();
  const meta = new Map<Hex, (typeof jobs)[number]>();
  let failed = 0;
  await Promise.all(jobs.map(async (j) => {
    try {
      const h = await pub.sendRawTransaction({ serializedTransaction: j.raw });
      sentAt.set(h, Date.now());
      meta.set(h, j);
    } catch {
      failed++;
    }
  }));
  // one eth_getLogs poll confirms the whole round (public RPCs allow ~15 requests/s)
  const done: { hash: Hex; block: bigint; ms: number; caseId: string; value: number }[] = [];
  const triggered: { caseId: string; value: number; hash: Hex; block: string }[] = [];
  const payments: { caseId: string; amountWei: string; seconds: number; hash: Hex }[] = [];
  const seen = new Set<Hex>();
  const addrs = [...new Set(active.map((c) => c.address as Address))];
  const deadline = Date.now() + 25_000;
  while (seen.size < sentAt.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const logs = await pub.getLogs({ address: addrs, fromBlock, toBlock: "latest" });
    for (const l of logs) {
      const h = l.transactionHash as Hex;
      if (!sentAt.has(h)) continue;
      let ev;
      try { ev = decodeEventLog({ abi: SENSOR_ABI, data: l.data, topics: l.topics }); } catch { continue; }
      const j = meta.get(h)!;
      if (ev.eventName === "Reading" && !seen.has(h)) {
        seen.add(h);
        done.push({ hash: h, block: l.blockNumber!, ms: Date.now() - sentAt.get(h)!, caseId: j.caseId, value: j.value });
      }
      if (ev.eventName === "Compensation" && !payments.some((p) => p.hash === h)) {
        const a = ev.args as { amount: bigint; secondsPaid: number };
        payments.push({ caseId: j.caseId, amountWei: a.amount.toString(), seconds: Number(a.secondsPaid), hash: h });
      }
    }
  }
  failed += sentAt.size - seen.size;

  const perBlock = new Map<string, number>();
  for (const d of done) perBlock.set(d.block.toString(), (perBlock.get(d.block.toString()) ?? 0) + 1);
  const ms = done.map((d) => d.ms).sort((a, b) => a - b);

  return {
    ok: true,
    sent: jobs.length,
    confirmed: done.length,
    failed,
    samplesOffChain: samples,
    blocks: [...perBlock.keys()].sort(),
    maxPerBlock: Math.max(0, ...perBlock.values()),
    p50ms: ms[Math.floor(ms.length / 2)] ?? 0,
    totalMs: Date.now() - t0,
    triggered: [...hotSet].map((a) => ({ caseId: active.find((c) => c.address === a)!.caseId, value: 0, hash: "0x" as Hex, block: "" })),
    payments,
    hashes: done.map((d) => d.hash),
    gatewayMon: formatEther(await pub.getBalance({ address: account.address })),
  };
}
