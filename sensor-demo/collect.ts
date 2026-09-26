// Collects every transaction of the MON sensor contracts from Monad testnet into data/tx-history.json:
// contract events (readings, excursions, MON payments, deliveries), receipts and block times, plus both wallets'
// MON balances. Read-only; throttled for the public RPC (15 requests/s, 100-block log ranges).
//   npx tsx --env-file=.env collect.ts          (FROM_BLOCK=… to override the start block)
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, formatEther, http, type Address, type Hex } from "viem";
import { DEPLOYMENT_FILE, PAYOUT, PAYOUT_FACTORY, ROOT } from "./common.js";

const RPC = "https://testnet-rpc.monad.xyz";
const pub = createPublicClient({ transport: http(RPC, { retryCount: 6, retryDelay: 400 }) });
const dep = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ABI = [...PAYOUT.abi, ...PAYOUT_FACTORY.abi];

const caseOf = new Map<string, string>(dep.copies.map((c: { address: string; caseId: string }) => [c.address.toLowerCase(), c.caseId]));
const addresses = [...dep.copies.map((c: { address: Address }) => c.address), dep.factory] as Address[];

const latest = await pub.getBlockNumber();
const first = BigInt(process.env.FROM_BLOCK ?? dep.fromBlock ?? (latest - 3000n).toString());

const logs = [];
for (let from = first; from <= latest; from += 100n) {
  const to = from + 99n < latest ? from + 99n : latest; // public RPC: 100-block range
  logs.push(...(await pub.getLogs({ address: addresses, fromBlock: from, toBlock: to })));
  await sleep(90);
}

type Tx = {
  hash: Hex; block: string; time: number; status: string; feeMon: string; kind: string;
  caseId?: string; value?: number; paidMon?: number; seconds?: number; refundMon?: number;
};
const txs = new Map<Hex, Tx>();
for (const l of logs) {
  const h = l.transactionHash!;
  if (!txs.has(h)) txs.set(h, { hash: h, block: l.blockNumber!.toString(), time: 0, status: "", feeMon: "0", kind: "" });
  const t = txs.get(h)!;
  let ev;
  try { ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { continue; }
  const a = ev.args as Record<string, unknown>;
  const c = caseOf.get(l.address.toLowerCase());
  if (c) t.caseId = c;
  switch (ev.eventName) {
    case "Reading": t.kind ||= "Sensor reading"; t.value = Number(a.value); break;
    case "ExcursionStarted": if (t.kind !== "MON payment") t.kind = "Excursion starts"; break;
    case "Compensation": t.kind = "MON payment"; t.paidMon = Number(formatEther(a.amount as bigint)); t.seconds = Number(a.secondsPaid); break;
    case "ExcursionEnded": if (t.kind !== "MON payment") t.kind = "Excursion ends"; break;
    case "Delivered": t.kind = "Delivery refund"; t.refundMon = Number(formatEther(a.refund as bigint)); break;
    case "Created": t.kind = "Create sensor contracts"; break;
  }
}

const blocks = new Set<bigint>();
for (const t of txs.values()) {
  const r = await pub.getTransactionReceipt({ hash: t.hash });
  t.status = r.status;
  t.feeMon = formatEther(r.gasUsed * r.effectiveGasPrice);
  blocks.add(r.blockNumber);
  await sleep(80);
}
const times = new Map<bigint, number>();
for (const b of blocks) {
  times.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));
  await sleep(80);
}
for (const t of txs.values()) t.time = times.get(BigInt(t.block)) ?? 0;

const out = {
  collectedAt: new Date().toISOString(),
  rpc: RPC,
  deployment: dep,
  balances: {
    customerMon: Number(formatEther(await pub.getBalance({ address: dep.customer }))),
    carrierMon: Number(formatEther(await pub.getBalance({ address: dep.carrier }))),
    atBlock: latest.toString(),
  },
  txs: [...txs.values()].sort((a, b) => Number(BigInt(a.block) - BigInt(b.block))),
};
writeFileSync(`${ROOT}sensor-demo/data/tx-history.json`, JSON.stringify(out, null, 1) + "\n");
const paid = out.txs.reduce((s, t) => s + (t.paidMon ?? 0), 0);
console.log(`${out.txs.length} transactions (${logs.length} logs), ${paid.toFixed(4)} MON paid to wallet 2 → sensor-demo/data/tx-history.json`);
