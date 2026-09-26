// Terminal feed of contract events (stage backup, and a check of src/events.ts).
// Env: CONTRACT_ADDRESS, RPC_URL (optional), FROM_BLOCK (optional), SECONDS (optional, default forever).
import type { Address } from "viem";
import { startPoller } from "../../src/chain/custody/events.js";

const stop = startPoller({
  contract: process.env.CONTRACT_ADDRESS as Address,
  rpcUrl: process.env.RPC_URL,
  fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : undefined,
  onEvent: (e) => {
    const args = Object.entries(e.args).map(([k, v]) => `${k}=${String(v).slice(0, 18)}`).join(" ");
    console.log(`${e.final ? "final  " : "pending"} #${e.blockNumber}:${e.logIndex} ${e.name.padEnd(16)} ${args}`);
  },
});
if (process.env.SECONDS) setTimeout(() => { stop(); process.exit(0); }, Number(process.env.SECONDS) * 1000);
