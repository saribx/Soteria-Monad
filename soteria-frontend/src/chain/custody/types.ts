import type { Hex } from "viem";

export const OPS = ["createShipment", "commitBatch", "handover", "alarm", "postKeys"] as const;
export type Op = (typeof OPS)[number];

export type RelayRequest = { op: Op; args: readonly unknown[] };
export type RelayResult =
  | { ok: true; hash: Hex; blockNumber: string; ms: number; simMs: number; totalMs: number; gasUsed: string }
  | { ok: false; rejected: true; reason: string }
  | { ok: false; rejected: false; error: string };
