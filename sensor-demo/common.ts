// Shared setup for the sensor demo: network, wallets, contract artifacts, case templates.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, defineChain, formatEther, http, stringToHex,
  type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { roundRobin, TESTNET_RPCS } from "../soteria-frontend/api/_lib/rpc.js";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const NETWORK = (process.env.NETWORK ?? "local") as "local" | "testnet";
export const RPC_URL = process.env.RPC_URL ?? (NETWORK === "testnet" ? "https://testnet-rpc.monad.xyz" : "http://127.0.0.1:8545");
export const DEPLOYMENT_FILE = `${ROOT}sensor-demo/deployments/${NETWORK}.json`;

// anvil started with `--chain-id 10143` uses its Monad config, so local and testnet share a chain id.
export const chain = defineChain({
  id: 10143,
  name: NETWORK === "testnet" ? "Monad Testnet" : "Local (anvil, Monad config)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
export const explorer = (hash: string) =>
  NETWORK === "testnet" ? `https://testnet.monadvision.com/tx/${hash}` : `(local tx ${hash.slice(0, 10)}…, not on testnet)`;

// anvil dev key #0 for local runs only
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// the sensor gateway: deploys, is the contracts' oracle and pays gas (same variable as on Vercel)
const deployerKey = (process.env.SENSOR_GATEWAY_KEY ?? process.env.DEPLOYER_KEY ?? (NETWORK === "local" ? ANVIL0 : "")) as Hex;
if (!deployerKey) throw new Error("SENSOR_GATEWAY_KEY is not set (sensor-demo/.env)");
export const deployer = privateKeyToAccount(deployerKey);

/** Wallet 1 = carrier (posts the bond), wallet 2 = customer (receives it on a breach). Only receive; need no MON. */
export const WALLET_1 = (process.env.WALLET_1 ?? "0x00000000000000000000000000000000000000c1") as Address;
export const WALLET_2 = (process.env.WALLET_2 ?? "0x00000000000000000000000000000000000000c2") as Address;

// testnet: several public RPCs round-robin, rate-limited (see rpc.ts); local: anvil directly
const transport = NETWORK === "testnet" && !process.env.RPC_URL
  ? roundRobin((process.env.RPC_URLS ?? TESTNET_RPCS.join(",")).split(","))
  : http(RPC_URL);
export const pub = createPublicClient({ chain, transport, pollingInterval: 400 });
export const wallet = createWalletClient({ account: deployer, chain, transport });

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = (file: string, name: string): Artifact => {
  const p = `${ROOT}contracts/out/${file}/${name}.json`;
  if (!existsSync(p)) throw new Error(`missing ${p}: run \`forge build\` in contracts/`);
  return JSON.parse(readFileSync(p, "utf8"));
};
export const PAYOUT_FACTORY = artifact("SensorPayout.sol", "SensorPayoutFactory");
export const PAYOUT = artifact("SensorPayout.sol", "SensorPayout");
/** Demo scale for MON payouts: 1 MON stands for EUR 100,000 (so EUR 20/s = 0.0002 MON/s). */
export const EUR_PER_MON = Number(process.env.EUR_PER_MON ?? "100000");
export const eurToWei = (eur: number) => (BigInt(Math.round(eur * 1e6)) * 10n ** 18n) / (BigInt(EUR_PER_MON) * 10n ** 6n);


export const ABOVE = 1;
export const BELOW = 2;

export type Template = {
  caseId: string; // "s1/W02/temp"
  goods: string;
  what: string; // human condition, e.g. "above −15.0 °C"
  trigger: number;
  limit: number; // tenths
  bondEur: number;
  graceS: number; // from the case data (reefers 10 s); 0 = pays from the first second
  rateEur: number; // EUR per second out of limits after the grace period
  normal: () => number; // simulated healthy reading (tenths)
  center: number; // healthy reading = center ± spread (tenths), for the web page's server function
  spread: number;
  breach: number; // simulated failing reading (tenths)
};

const jitter = (center: number, spread: number) => () => Math.round(center + (Math.random() * 2 - 1) * spread);

/** One template per monitored condition in data/monad/demo.json; bonds from the case data and contract files. */
export function loadTemplates(): Template[] {
  const demo = JSON.parse(readFileSync(`${ROOT}data/monad/demo.json`, "utf8"));
  const out: Template[] = [];
  for (const [caseKey, c] of Object.entries<any>(demo.cases)) {
    const contract = JSON.parse(readFileSync(`${ROOT}data/contracts/${c.contract}.json`, "utf8"));
    const penalty: number = contract.records.contract.contract_penalty;
    for (const [wagon, w] of Object.entries<any>(c.wagons)) {
      if (w.kind === "reefer") {
        const max = Math.round(w.max_c * 10), set = Math.round(w.setpoint_c * 10);
        out.push({
          caseId: `${caseKey}/${wagon}/temp`, goods: w.goods, what: `above ${w.max_c} °C (overheat)`,
          trigger: ABOVE, limit: max, bondEur: w.cap_eur ?? penalty, graceS: w.grace_s ?? 0, rateEur: w.rate_eur_s ?? w.cap_eur ?? penalty,
          normal: jitter(set, Math.max(3, Math.floor((max - set) / 4))), center: set, spread: Math.max(3, Math.floor((max - set) / 4)), breach: max + 8,
        });
      } else if (w.kind === "tank") {
        const minBar = Math.round(w.min_bar * 10), bar = Math.round(w.pressure_bar * 10);
        out.push({
          caseId: `${caseKey}/${wagon}/pressure`, goods: w.goods, what: `below ${w.min_bar} bar (leak)`,
          trigger: BELOW, limit: minBar, bondEur: penalty, graceS: 0, rateEur: penalty, normal: jitter(bar, 1), center: bar, spread: 1, breach: minBar - 7,
        });
        const g = Math.round(w.shock_max_g * 10);
        out.push({
          caseId: `${caseKey}/${wagon}/shock`, goods: w.goods, what: `above ${w.shock_max_g} g (impact)`,
          trigger: ABOVE, limit: g, bondEur: penalty, graceS: 0, rateEur: penalty, normal: jitter(4, 3), center: 4, spread: 3, breach: g + 14,
        });
      }
    }
  }
  return out;
}

export const caseIdHex = (id: string) => stringToHex(id, { size: 32 });

export const mon = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} MON`;

/** Refuses to spend more than MAX_MON on gas in one run. */
export function checkBudget(estimate: bigint) {
  const cap = BigInt(Math.round(Number(process.env.MAX_MON ?? "0.5") * 1e6)) * 10n ** 12n;
  console.log(`estimated gas cost ${mon(estimate)} (cap MAX_MON=${mon(cap)})`);
  if (estimate > cap) throw new Error("estimate above MAX_MON; lower COPIES/ROUNDS or raise MAX_MON");
}
