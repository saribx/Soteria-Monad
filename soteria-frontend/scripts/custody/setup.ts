// Registers the demo parties on the deployed contract and funds carrier tEUR balances.
// Env: DEPLOYER_KEY (contract owner), CONTRACT_ADDRESS, RPC_URL (optional).
// Writes demo/parties.json (public keys and names) for the dashboard. Safe to re-run.
import { writeFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { custodyAbi } from "../../src/chain/custody/abi.js";
import { makePublicClient, monad } from "../../src/chain/custody/client.js";
import { ROLE } from "../../src/chain/custody/messages.js";
import { DEMO_DIR, loadOrCreateDemoKeys } from "./demoKeys.js";

const rpcUrl = process.env.RPC_URL ?? monad.rpcUrls.default.http[0];
const contract = process.env.CONTRACT_ADDRESS as Address;
const deployer = process.env.DEPLOYER_KEY as Hex;
if (!contract || !deployer) throw new Error("set CONTRACT_ADDRESS and DEPLOYER_KEY");

const FUND_TO = 1_000_000n; // 10,000.00 tEUR per carrier

const pub = makePublicClient(rpcUrl);
const wallet = createWalletClient({ account: privateKeyToAccount(deployer), chain: monad, transport: http(rpcUrl) });

async function send(functionName: "registerParty" | "faucet", args: readonly unknown[]) {
  const data = encodeFunctionData({ abi: custodyAbi, functionName, args: args as never });
  const r = await wallet.sendTransactionSync({ to: contract, data });
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${r.transactionHash}`);
  return r;
}

const parties = await loadOrCreateDemoKeys();
for (const p of parties) {
  const [, , role] = await pub.readContract({ address: contract, abi: custodyAbi, functionName: "parties", args: [p.k.key] });
  if (role === p.role) {
    console.log(`= ${p.name.padEnd(20)} already registered`);
  } else {
    const r = await send("registerParty", [p.k.x, p.k.y, p.role, p.name]);
    console.log(`+ ${p.name.padEnd(20)} registered  block ${r.blockNumber}`);
  }
  if (p.role === ROLE.carrier) {
    const bal = await pub.readContract({ address: contract, abi: custodyAbi, functionName: "balanceOf", args: [p.k.key] });
    if (bal < FUND_TO) {
      await send("faucet", [p.k.key, FUND_TO - bal]);
      console.log(`  ${p.name} funded to ${Number(FUND_TO) / 100} tEUR`);
    }
  }
}

const out = parties.map((p) => ({ slot: p.slot, name: p.name, role: p.role, x: p.k.x, y: p.k.y, key: p.k.key }));
writeFileSync(process.env.PARTIES_OUT ?? DEMO_DIR + "parties.json", JSON.stringify({ contract, chainId: monad.id, parties: out }, null, 2) + "\n");
console.log(`wrote ${process.env.PARTIES_OUT ?? "demo/parties.json"}`);
