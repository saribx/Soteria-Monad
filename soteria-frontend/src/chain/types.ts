// Shapes of what the relayer streams (see relayer/src/server.ts and scenarios.ts)

export type CaseId = 's1' | 's3';
export type Phase = 'idle' | 'normal' | 'incident';

export interface Limits {
  minC?: number;
  maxC?: number;
  minBar?: number;
  shockMaxG?: number;
  graceS?: number;
  rateEur?: number;
  capEur?: number;
}

export interface DeviceMeta {
  key: string; // "s1/W02"
  caseId: CaseId | 'storm';
  wagon: string; // "W02", "LOCO"
  kind: 'reefer' | 'tank' | 'loco';
  goods: string;
  address: string;
  limits: Limits;
  wagonId: number | null;
  bound: boolean;
  active: boolean;
  sent: number;
  halted: string | null;
}

export interface Step {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  tx?: string;
  detail?: string;
  atMs?: number;
}

export interface RunState {
  running: boolean;
  steps: Step[];
  startedAt?: number;
  shipmentId?: number;
}

export interface CaseState extends RunState {
  phase: Phase;
}

export interface DemoState {
  network: 'local' | 'testnet' | 'mainnet';
  live: boolean;
  busy: string | null;
  sendMode: string;
  budget: { capMon: number; spentMon: number; txs: number; reverted: number; exhausted: boolean };
  cases: Record<CaseId, CaseState>;
  storm: RunState;
  devices: DeviceMeta[];
  events: { name: string; args: Record<string, string | number | boolean>; tx: string; block: number; at: number }[];
}

export interface CaseSpec {
  shipment_ref: string;
  incident: string;
  customer: string;
  contract: string;
  ambient_c: number;
  ambient_note: string;
  speed_kmh: { before: number; after: number };
  start_behind_m?: number;
  wagons: Record<string, { kind: 'reefer' | 'tank'; goods: string; [k: string]: unknown }>;
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
  cases: Record<CaseId, CaseSpec>;
  storm: { wagons: number; seconds: number };
}

export interface Hello {
  network: 'local' | 'testnet' | 'mainnet';
  chainId: number;
  ws: string;
  http: string;
  explorer: string;
  rail: `0x${string}`;
  teur: `0x${string}`;
  spendCapMon: number;
  demo: DemoSpec;
}

export interface TxInfo {
  hash: string;
  label: string;
  from: string;
  device?: string;
  sentAt: number;
  receiptAt?: number;
  latencyMs?: number;
  block?: number;
  ok?: boolean;
  gas?: number;
  error?: string;
  finalizedAt?: number;
}

export interface ChainEvent {
  key: string;
  name: string;
  args: Record<string, string | number | boolean>;
  tx: string;
  block: number;
  at: number; // when this dashboard first saw it
  source: 'chain' | 'relayer';
  commit?: string; // Proposed | Voted | Finalized
  finalizedAt?: number;
}
