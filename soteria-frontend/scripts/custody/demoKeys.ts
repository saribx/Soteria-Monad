// Demo party keys. These are published with the dashboard on purpose: "simulated sensor, real signature".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJwk, generateKey, importJwk, type P256Key } from "../../src/chain/custody/keys.js";
import { ROLE } from "../../src/chain/custody/messages.js";

export const DEMO_DIR = fileURLToPath(new URL("../../src/chain/custody/demo/", import.meta.url));
const KEYS_FILE = DEMO_DIR + "demo-keys.json";

export type Slot = "shipper" | "carrierA" | "carrierB" | "receiver" | `wagon${number}`;
type Entry = { slot: Slot; name: string; role: number; jwk: JsonWebKey };

const PLAN: { slot: Slot; name: string; role: number }[] = [
  { slot: "shipper", name: "Glaswerk Duisburg", role: ROLE.shipper },
  { slot: "carrierA", name: "Carrier A (DE)", role: ROLE.carrier },
  { slot: "carrierB", name: "Carrier B (PL)", role: ROLE.carrier },
  { slot: "receiver", name: "Receiver Poznań", role: ROLE.receiver },
  ...[0, 1, 2, 3, 4].map((i) => ({ slot: `wagon${i}` as Slot, name: `Wagon ${i}`, role: ROLE.wagon })),
];

export type DemoParty = { slot: Slot; name: string; role: number; k: P256Key };

export async function loadOrCreateDemoKeys(): Promise<DemoParty[]> {
  let entries: Entry[];
  if (existsSync(KEYS_FILE)) {
    entries = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  } else {
    entries = [];
    for (const p of PLAN) entries.push({ ...p, jwk: await exportJwk(await generateKey()) });
    mkdirSync(dirname(KEYS_FILE), { recursive: true });
    writeFileSync(KEYS_FILE, JSON.stringify(entries, null, 2) + "\n");
  }
  return Promise.all(entries.map(async (e) => ({ slot: e.slot, name: e.name, role: e.role, k: await importJwk(e.jwk) })));
}

export const bySlot = (ps: DemoParty[], slot: Slot) => {
  const p = ps.find((x) => x.slot === slot);
  if (!p) throw new Error(`missing demo party ${slot}`);
  return p;
};
