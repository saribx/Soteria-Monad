// Fair-model demo with MON payouts. Every INTERVAL_MS all sensors send one reading at once (every 10th sample of a
// simulated 4 Hz stream). From HOT_FROM the TRIGGER wagons run out of limits for HOT_ROUNDS rounds: the contract starts
// an excursion, pays nothing during the grace period, then pays `seconds × rate` in MON to wallet 2 with every reading,
// until the wagon is back inside its limits.
//   ROUNDS=14 INTERVAL_MS=2000 HOT_FROM=3 HOT_ROUNDS=9 TRIGGER="s1/W02/temp,s3/W02/temp" MAX_MON=1
// Sensor VALUES are simulated. Transactions and MON payments are real.
import { readFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT_FILE, NETWORK, PAYOUT, chain, checkBudget, deployer, explorer, loadTemplates, mon, pub } from "./common.js";

const ROUNDS = Number(process.env.ROUNDS ?? "14");
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? "2000");
const HOT_FROM = Number(process.env.HOT_FROM ?? "3");
const HOT_ROUNDS = Number(process.env.HOT_ROUNDS ?? "9");
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? "10");
const TRIGGER = (process.env.TRIGGER ?? "s1/W02/temp,s3/W02/temp").split(",").map((s) => s.trim()).filter(Boolean);
const HOT_GAS = 160_000n; // a paying reading: excursion bookkeeping + MON transfer (~80k measured) with headroom
process.env.MAX_MON ??= "1";

const dep = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as {
  customer: Address; carrier: Address; eurPerMon: number; copies: { address: Address; caseId: string }[];
};
const templates = new Map(loadTemplates().map((t) => [t.caseId, t]));
const fmt = (id: string, v: number) => (id.endsWith("/temp") ? `${(v / 10).toFixed(1)} °C` : id.endsWith("/pressure") ? `${(v / 10).toFixed(1)} bar` : `${(v / 10).toFixed(1)} g`);
const hot = new Set(dep.copies.filter((c) => TRIGGER.includes(c.caseId)).map((c) => c.address));

const fees = await pub.estimateFeesPerGas();
const normalGas = new Map<string, bigint>();
for (const c of dep.copies) {
  const t = templates.get(c.caseId)!;
  const est = await pub.estimateContractGas({ address: c.address, abi: PAYOUT.abi, functionName: "report", args: [t.normal()], account: deployer });
  normalGas.set(c.address, (est * 125n) / 100n);
}
const perRound = dep.copies.reduce((s, c) => s + (hot.has(c.address) ? HOT_GAS : normalGas.get(c.address)!), 0n);
console.log(`network ${NETWORK} · sensor gateway ${deployer.address} · ${mon(await pub.getBalance({ address: deployer.address }))}`);
console.log(`${dep.copies.length} sensors × ${ROUNDS} rounds every ${INTERVAL_MS / 1000} s · out of limits rounds ${HOT_FROM}–${HOT_FROM + HOT_ROUNDS - 1}: ${TRIGGER.join(", ")}`);
checkBudget(fees.maxFeePerGas! * perRound * BigInt(ROUNDS));
console.log("sensor values: SIMULATED · transactions and MON payments: REAL\n");

const w2Before = await pub.getBalance({ address: dep.customer });
let nonce = await pub.getTransactionCount({ address: deployer.address, blockTag: "pending" });
const payments: { caseId: string; amount: bigint; secs: number; total: bigint; hash: Hex; block: bigint }[] = [];
let sent = 0, onChain = 0, samples = 0;
const perBlock = new Map<bigint, number>();
const failures: string[] = [];
const t0 = Date.now();

for (let round = 1; round <= ROUNDS; round++) {
  const tRound = Date.now();
  const isHot = round >= HOT_FROM && round < HOT_FROM + HOT_ROUNDS;
  const jobs: { raw: Hex; caseId: string; value: number; address: Address }[] = [];
  for (const c of dep.copies) {
    const t = templates.get(c.caseId)!;
    const heat = isHot && hot.has(c.address);
    // off-chain window of samples; a hot wagon drifts further past its limit each round
    const window = Array.from({ length: SAMPLE_EVERY }, () => (heat ? t.breach + (round - HOT_FROM) * (t.trigger === 1 ? 2 : -1) : t.normal()));
    samples += window.length;
    const value = window[window.length - 1];
    const raw = await deployer.signTransaction({
      chainId: chain.id, type: "eip1559", to: c.address, nonce: nonce++,
      gas: hot.has(c.address) ? HOT_GAS : normalGas.get(c.address)!,
      maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
      data: encodeFunctionData({ abi: PAYOUT.abi, functionName: "report", args: [value] }),
    });
    jobs.push({ raw, caseId: c.caseId, value, address: c.address });
  }

  const fromBlock = await pub.getBlockNumber();
  const hashes = new Map<Hex, (typeof jobs)[number]>();
  await Promise.all(jobs.map(async (j) => {
    try { hashes.set(await pub.sendRawTransaction({ serializedTransaction: j.raw }), j); sent++; }
    catch (e) { failures.push(`${j.caseId}: ${(e as Error).message.split("\n")[0]}`); }
  }));
  const seen = new Set<Hex>();
  const notes: string[] = [];
  const deadline = Date.now() + 20_000;
  while (seen.size < hashes.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const logs = await pub.getLogs({ address: dep.copies.map((c) => c.address), fromBlock, toBlock: "latest" });
    for (const l of logs) {
      const h = l.transactionHash as Hex;
      const j = hashes.get(h);
      if (!j) continue;
      let ev;
      try { ev = decodeEventLog({ abi: PAYOUT.abi, data: l.data, topics: l.topics }); } catch { continue; }
      const key = `${h}:${l.logIndex}`;
      if (seen.has(key as Hex)) continue;
      if (ev.eventName === "Reading") { seen.add(h); onChain++; perBlock.set(l.blockNumber!, (perBlock.get(l.blockNumber!) ?? 0) + 1); }
      seen.add(key as Hex);
      const a = ev.args as { amount?: bigint; secondsPaid?: number; totalPaid?: bigint };
      if (ev.eventName === "ExcursionStarted") notes.push(`🔥 ${j.caseId} out of limits at ${fmt(j.caseId, j.value)}: excursion starts, grace ${templates.get(j.caseId)!.graceS} s`);
      if (ev.eventName === "Compensation") {
        payments.push({ caseId: j.caseId, amount: a.amount!, secs: Number(a.secondsPaid), total: a.totalPaid!, hash: h, block: l.blockNumber! });
        notes.push(`💸 ${j.caseId} ${fmt(j.caseId, j.value)} → ${mon(a.amount!)} to wallet 2 for ${a.secondsPaid} s (total ${mon(a.totalPaid!)}) ${explorer(h)}`);
      }
      if (ev.eventName === "ExcursionEnded") notes.push(`✅ ${j.caseId} back to ${fmt(j.caseId, j.value)}: excursion ended, payments stop`);
    }
  }
  const got = [...hashes.keys()].filter((h) => seen.has(h)).length;
  if (got < hashes.size) failures.push(`round ${round}: ${hashes.size - got} readings not seen within 20 s`);
  console.log(`round ${String(round).padStart(2)} ${isHot ? "(hot) " : "      "}${got}/${jobs.length} on chain after ${Date.now() - tRound} ms`);
  for (const n of notes) console.log(`   ${n}`);
  const wait = INTERVAL_MS - (Date.now() - tRound);
  if (round < ROUNDS && wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const w2After = await pub.getBalance({ address: dep.customer });
const paid = payments.reduce((s, p) => s + p.amount, 0n);
const secs = (Date.now() - t0) / 1000;
console.log(`\n=== ${onChain} real sensor transactions in ${secs.toFixed(1)} s · ${perBlock.size} blocks · up to ${Math.max(0, ...perBlock.values())} in one block ===`);
console.log(`sensor data: ${samples} simulated samples off-chain → ${onChain} on-chain`);
console.log(`MON paid by the contracts to wallet 2 (${dep.customer}): ${mon(paid)} in ${payments.length} payments  (≈ EUR ${(Number(paid) / 1e18 * dep.eurPerMon).toLocaleString("de-DE")})`);
console.log(`wallet 2 MON balance: ${mon(w2Before)} → ${mon(w2After)}  (+${mon(w2After - w2Before)})`);
console.log(`sensor gateway balance ${mon(await pub.getBalance({ address: deployer.address }))}`);
if (failures.length) console.log(`problems:\n  ${failures.slice(0, 6).join("\n  ")}`);
process.exit(failures.length ? 1 : 0);
