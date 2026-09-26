// Deploys SensorPayoutFactory and one MON-funded SensorPayout per case condition (COPIES=1).
// Compensation follows the case data: grace period, EUR per second, cap; paid in MON at EUR_PER_MON (default 100,000).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address } from "viem";
import {
  DEPLOYMENT_FILE, EUR_PER_MON, NETWORK, PAYOUT_FACTORY, ROOT, WALLET_1, WALLET_2, caseIdHex, checkBudget, deployer,
  eurToWei, explorer, loadTemplates, mon, pub, wallet,
} from "./common.js";

const COPIES = Number(process.env.COPIES ?? "1");
process.env.MAX_MON ??= "1.5";
const templates = loadTemplates();
const bonds = templates.reduce((s, t) => s + eurToWei(t.bondEur), 0n) * BigInt(COPIES);

console.log(`network ${NETWORK} · deployer ${deployer.address} · ${mon(await pub.getBalance({ address: deployer.address }))}`);
console.log(`wallet 1 (carrier)  ${WALLET_1}\nwallet 2 (customer) ${WALLET_2}\nscale: 1 MON = EUR ${EUR_PER_MON.toLocaleString("de-DE")}\n`);
for (const t of templates) {
  console.log(`  ${t.caseId.padEnd(16)} ${t.goods.padEnd(17)} ${t.what.padEnd(26)} grace ${String(t.graceS).padStart(2)} s · ${mon(eurToWei(t.rateEur))}/s · cap ${mon(eurToWei(t.bondEur))}`);
}
const fees = await pub.estimateFeesPerGas();
checkBudget(fees.maxFeePerGas! * BigInt(1_300_000 + 260_000 * templates.length * COPIES) + bonds);

const send = async (label: string, p: Promise<`0x${string}`>) => {
  const hash = await p;
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 400 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`✓ ${label.padEnd(30)} block ${r.blockNumber}  gas ${r.gasUsed}  ${explorer(hash)}`);
  return r;
};

const factoryReceipt = await send("deploy SensorPayoutFactory", wallet.deployContract({ abi: PAYOUT_FACTORY.abi, bytecode: PAYOUT_FACTORY.bytecode.object }));
const factory = factoryReceipt.contractAddress as Address;
const ts = templates.map((t) => ({
  caseId: caseIdHex(t.caseId), trigger: t.trigger, limit: t.limit, graceS: t.graceS, rate: eurToWei(t.rateEur), cap: eurToWei(t.bondEur),
}));
await send(`createMany (${templates.length * COPIES} copies, ${mon(bonds)} bonds)`, wallet.writeContract({
  address: factory, abi: PAYOUT_FACTORY.abi, functionName: "createMany", value: bonds,
  args: [ts, COPIES, { oracle: deployer.address, carrier: WALLET_1, customer: WALLET_2 }],
}));
const addrs = (await pub.readContract({ address: factory, abi: PAYOUT_FACTORY.abi, functionName: "all" })) as Address[];
const dep = {
  network: NETWORK, kind: "payout-mon", eurPerMon: EUR_PER_MON, factory, fromBlock: factoryReceipt.blockNumber.toString(), oracle: deployer.address, carrier: WALLET_1, customer: WALLET_2,
  copies: addrs.map((address, i) => ({ address, caseId: templates[Math.floor(i / COPIES)].caseId, index: i % COPIES })),
  templates: templates.map(({ normal: _n, ...t }) => ({ ...t, rateWei: eurToWei(t.rateEur).toString(), capWei: eurToWei(t.bondEur).toString() })),
};
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2) + "\n");
// the web page and /api/sensors use the testnet deployment only; a local run must not overwrite it
if (NETWORK === "testnet") {
  const web = `${ROOT}soteria-frontend/src/sensors/deployment.json`;
  mkdirSync(dirname(web), { recursive: true });
  writeFileSync(web, JSON.stringify(dep, null, 2) + "\n");
}
console.log(`\n${addrs.length} MON-funded sensor contracts → ${DEPLOYMENT_FILE.replace(/.*sensor-demo\//, "sensor-demo/")}`);
console.log(`deployer balance now ${mon(await pub.getBalance({ address: deployer.address }))}`);
