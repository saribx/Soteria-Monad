import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RELAYER_DIR = resolve(ROOT, 'relayer');

export type NetworkName = 'local' | 'testnet' | 'mainnet';

export interface Endpoint {
  url: string;
  rps: number; // we stay at ~80% of the published limit
}

export interface NetworkDef {
  name: NetworkName;
  chainId: number;
  rpc: Endpoint[];
  ws: string;
  explorer: string;
  defaultSpendCapMon: number;
  defaultLiveMinutes: number; // the demo stops itself after this long without a control action
}

// Public endpoints and limits from https://docs.monad.xyz (Network Information)
export const NETWORKS: Record<NetworkName, NetworkDef> = {
  local: {
    name: 'local',
    chainId: 31337,
    rpc: [{ url: 'http://127.0.0.1:8545', rps: 1000 }],
    ws: 'ws://127.0.0.1:8545',
    explorer: '',
    defaultSpendCapMon: 1_000_000,
    defaultLiveMinutes: 0,
  },
  testnet: {
    name: 'testnet',
    chainId: 10143,
    rpc: [
      { url: 'https://testnet-rpc.monad.xyz', rps: 40 },
      { url: 'https://rpc.ankr.com/monad_testnet', rps: 24 },
      { url: 'https://rpc-testnet.monadinfra.com', rps: 16 },
    ],
    ws: 'wss://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadvision.com',
    defaultSpendCapMon: 5,
    defaultLiveMinutes: 30,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 143,
    rpc: [
      { url: 'https://rpc.monad.xyz', rps: 20 },
      { url: 'https://rpc2.monad.xyz', rps: 24 },
      { url: 'https://rpc3.monad.xyz', rps: 24 },
      { url: 'https://rpc1.monad.xyz', rps: 12 },
      { url: 'https://rpc-mainnet.monadinfra.com', rps: 16 },
    ],
    ws: 'wss://rpc.monad.xyz',
    explorer: 'https://monadvision.com',
    defaultSpendCapMon: 16,
    defaultLiveMinutes: 15,
  },
};

const name = (process.env.MONAD_NETWORK ?? 'local') as NetworkName;
if (!NETWORKS[name]) throw new Error(`MONAD_NETWORK must be local, testnet or mainnet, not ${name}`);

const base = NETWORKS[name];
export const NETWORK: NetworkDef = {
  ...base,
  rpc: process.env.RPC_URLS
    ? process.env.RPC_URLS.split(',').map(url => ({ url: url.trim(), rps: Number(process.env.RPC_RPS ?? 20) }))
    : base.rpc,
  ws: process.env.WS_URL ?? base.ws,
};

// Anvil's first default account; only ever used against the local chain
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function funderKey(): `0x${string}` {
  const key = process.env.FUNDER_PRIVATE_KEY ?? (name === 'local' ? ANVIL_KEY : undefined);
  if (!key) throw new Error('Set FUNDER_PRIVATE_KEY in relayer/.env (the wallet holding the MON)');
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
}

/** Hard ceiling on MON this relayer may spend on gas; it stops sending once reached. */
export const SPEND_CAP_MON = Number(process.env.MAX_MON_SPEND ?? base.defaultSpendCapMon);
export const PORT = Number(process.env.PORT ?? 8787);
/** Minutes without a control action after which a live demo closes its shipments (0: never). */
export const LIVE_MINUTES = Number(process.env.MAX_LIVE_MIN ?? base.defaultLiveMinutes);

// ---- demo configuration shared with the frontend

export interface ReeferSpec {
  kind: 'reefer';
  goods: string;
  setpoint_c: number;
  min_c: number;
  max_c: number;
  grace_s: number;
  rate_eur_s: number;
  cap_eur: number;
}
export interface TankSpec {
  kind: 'tank';
  goods: string;
  pressure_bar: number;
  min_bar: number;
  shock_max_g: number;
}
export type WagonSpec = ReeferSpec | TankSpec;

export interface CaseSpec {
  shipment_ref: string;
  incident: string;
  customer: string;
  contract: string;
  ambient_c: number;
  ambient_note: string;
  speed_kmh: { before: number; after: number };
  start_behind_m?: number;
  wagons: Record<string, WagonSpec>;
  damage_claim?: { wagon: string; amount_eur: number; what: string };
}

export interface DemoSpec {
  sample_hz: number;
  heartbeat_s: number;
  escalated_hz: number;
  calm_s: number;
  gap_after_s: number;
  max_standstill_s: number;
  challenge_window_s: number;
  cases: Record<'s1' | 's3', CaseSpec>;
  storm: { wagons: number; seconds: number; setpoint_c: number; min_c: number; max_c: number; note: string };
}

const json = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;

export const DEMO = json<DemoSpec>('data/monad/demo.json');

export interface ContractTerms {
  contract_penalty: number;
  contract_deadline_h: number;
  liability_cap: number;
}
export const contractTerms = (id: string) =>
  json<{ records: { contract: ContractTerms } }>(`data/contracts/${id}.json`).records.contract;

export interface TrainFile {
  train_id: string;
  wagons: { wagon_id: string; wagon_type: string; cargo_class: string }[];
}
export const trainOf = (caseId: string) => json<TrainFile>(`data/${caseId}/${caseId}_train.json`);

export interface SoteriaDecision {
  measures: { code: string; label: string }[];
  tier: number;
  keysNeeded: number;
  grants: string[];
  receiptHash: string;
}
export const soteriaDecision = (incidentId: string) =>
  json<Record<string, { decision: SoteriaDecision }>>('soteria-frontend/src/data/soteria.json')[incidentId]?.decision;
