// Plays the stage demo end to end through the relay core, with real P-256 signatures:
// create → batch → handover → forged batch → shock → stale alarm → unregistered shipper.
// Env: RELAYER_KEYS, CONTRACT_ADDRESS, RPC_URL (optional). Exits 1 if any step behaves unexpectedly.
import { keccak256, toHex, type Hex } from "viem";
import { custodyAbi } from "../../src/chain/custody/abi.js";
import { explorerTx, makePublicClient, monad } from "../../src/chain/custody/client.js";
import { generateKey, sign } from "../../src/chain/custody/keys.js";
import {
  KIND_SHOCK, STATUS, alarmMessage, batchMessage, createMessage, handoverMessage, type Ctx, type Terms,
} from "../../src/chain/custody/messages.js";
import { configFromEnv, relay, type Op, type RelayResult } from "../../api/_lib/relay.js";
import { bySlot, loadOrCreateDemoKeys } from "./demoKeys.js";

const cfg = configFromEnv();
const pub = makePublicClient(cfg.rpcUrl);
const ctx: Ctx = { chainId: monad.id, contract: cfg.contract };
// anvil runs with chain id 10143 too, so never print explorer links unless we really talk to Monad testnet.
const onTestnet = new URL(cfg.rpcUrl).hostname.endsWith("monad.xyz");
const ps = await loadOrCreateDemoKeys();
const [shipper, carrierA, carrierB, receiver] = (["shipper", "carrierA", "carrierB", "receiver"] as const).map((s) => bySlot(ps, s));
const wagons = [0, 1, 2, 3, 4].map((i) => bySlot(ps, `wagon${i}`));

let failures = 0;
async function step(label: string, op: Op, args: readonly unknown[], expect: "ok" | string) {
  const res: RelayResult = await relay(cfg, { op, args });
  const got = res.ok ? "ok" : res.rejected ? res.reason : `error: ${res.error}`;
  const pass = got === expect;
  if (!pass) failures++;
  const where = onTestnet ? explorerTx(res.ok ? res.hash : "") : "LOCAL ANVIL, not on testnet";
  const detail = res.ok
    ? `block ${res.blockNumber}  check ${res.simMs} ms + send ${res.ms} ms = ${res.totalMs} ms  gas ${res.gasUsed}  ${where}`
    : got;
  console.log(`${pass ? "✓" : "✗"} ${label.padEnd(34)} ${detail}${pass ? "" : `   (expected ${expect})`}`);
  return res;
}
const balance = (k: Hex) => pub.readContract({ address: cfg.contract, abi: custodyAbi, functionName: "balanceOf", args: [k] });

const id = BigInt(Date.now());
const now = BigInt(Math.floor(Date.now() / 1000));
const terms: Terms = {
  shipper: shipper.k.key, carrier: carrierA.k.key, receiver: receiver.k.key,
  penalty: 25_000n, cap: 40_000n, shockLimitCg: 300, expiry: now + 600n,
};
const wagonKeys = wagons.map((w) => w.k.key);
console.log(`shipment ${id} on ${cfg.contract} via ${onTestnet ? "Monad testnet" : "LOCAL chain " + cfg.rpcUrl}\n`);

// 1. create (shipper signs the terms)
const createSig = await sign(shipper.k, createMessage(ctx, id, terms, wagonKeys));
await step("create shipment", "createShipment", [id, terms, wagonKeys, createSig], "ok");

// 2. a sealed batch from wagon 0. This payload is a labelled test string, NOT encrypted readings:
//    anyone decoding it on-chain reads that it came from this script.
const ct = toHex("E2E TEST PAYLOAD - NOT SENSOR DATA - NOT ENCRYPTED");
const root = keccak256(toHex("readings seq 1"));
const bSig = await sign(wagons[0].k, batchMessage(ctx, id, 0, 1, 1n, root, STATUS.green, ct));
await step("batch wagon 0 (green)", "commitBatch", [id, 0, 1, 1n, root, STATUS.green, ct, bSig], "ok");

// 3. handover A → B at the border, both sign
const exp = now + 120n;
const reservation = keccak256(toHex("slot FFO-7"));
const hm = handoverMessage(ctx, id, 1, carrierA.k.key, carrierB.k.key, reservation, exp);
await step("handover A → B", "handover", [id, 1, carrierB.k.key, reservation, exp, await sign(carrierA.k, hm), await sign(carrierB.k, hm)], "ok");

// 4. forgery: an "all fine" batch for wagon 0 signed by someone else
const fSig = await sign(carrierB.k, batchMessage(ctx, id, 0, 2, 2n, root, STATUS.green, ct));
await step("forged batch", "commitBatch", [id, 0, 2, 2n, root, STATUS.green, ct, fSig], "BadSignature");

// 5. shock 5.20 g on wagon 0 during epoch 2 → Carrier B pays the shipper
const [bBefore, sBefore] = await Promise.all([balance(carrierB.k.key), balance(shipper.k.key)]);
const aSig = await sign(wagons[0].k, alarmMessage(ctx, id, 2, 0, 1n, KIND_SHOCK, 520));
await step("shock 5.20 g", "alarm", [id, 2, 0, 1n, KIND_SHOCK, 520, aSig], "ok");
const [bAfter, sAfter] = await Promise.all([balance(carrierB.k.key), balance(shipper.k.key)]);
const moved = bBefore - bAfter;
console.log(`  Carrier B −${Number(moved) / 100} tEUR, shipper +${Number(sAfter - sBefore) / 100} tEUR`);
if (moved !== 25_000n || sAfter - sBefore !== 25_000n) { failures++; console.log("✗ settlement amounts wrong"); }

// 6. an alarm signed for the old epoch
const stale = await sign(wagons[0].k, alarmMessage(ctx, id, 1, 0, 2n, KIND_SHOCK, 520));
await step("stale-epoch alarm", "alarm", [id, 1, 0, 2n, KIND_SHOCK, 520, stale], "StaleEpoch");

// 7. a stranger's key tries to create a shipment
const stranger = await generateKey();
const t2: Terms = { ...terms, shipper: stranger.key };
const sSig = await sign(stranger, createMessage(ctx, id + 1n, t2, wagonKeys));
await step("unregistered shipper", "createShipment", [id + 1n, t2, wagonKeys, sSig], "NotVerified");

const head = await pub.readContract({ address: cfg.contract, abi: custodyAbi, functionName: "head", args: [id] });
console.log(`\nhead(${id}) = ${head}`);
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps behaved as expected");
process.exit(failures ? 1 : 0);
