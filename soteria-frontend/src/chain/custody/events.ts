// Log poller for the dashboard: getLogs from cursor+1 every second, decoded with the Custody ABI.
// Dedupes by txHash:logIndex. An event is "final" once it is 2+ blocks old (Monad: finalized ~2 blocks later).
import { decodeEventLog, type Address, type Hex } from "viem";
import { custodyAbi } from "./abi.js";
import { makePublicClient } from "./client.js";

export type ChainEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  final: boolean;
};

export type PollerOptions = {
  contract: Address;
  rpcUrl?: string;
  fromBlock?: bigint; // default: latest - 500
  intervalMs?: number;
  onEvent: (e: ChainEvent) => void; // called once pending, and again when it turns final
};

const MAX_RANGE = 100n; // public RPCs cap getLogs ranges; stay well inside

export function startPoller(o: PollerOptions): () => void {
  const pub = makePublicClient(o.rpcUrl);
  const seen = new Map<string, ChainEvent>();
  let cursor: bigint | null = o.fromBlock ?? null;
  let stopped = false;

  async function tick() {
    const latest = await pub.getBlockNumber();
    let from: bigint = cursor ?? (latest > 500n ? latest - 500n : 0n);
    while (from <= latest && !stopped) {
      const to: bigint = from + MAX_RANGE - 1n < latest ? from + MAX_RANGE - 1n : latest;
      const logs = await pub.getLogs({ address: o.contract, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const id = `${log.transactionHash}:${log.logIndex}`;
        if (seen.has(id)) continue;
        let decoded;
        try {
          decoded = decodeEventLog({ abi: custodyAbi, data: log.data, topics: log.topics });
        } catch {
          continue;
        }
        const e: ChainEvent = {
          name: decoded.eventName,
          args: (decoded.args ?? {}) as Record<string, unknown>,
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          txHash: log.transactionHash!,
          final: latest - log.blockNumber! >= 2n,
        };
        seen.set(id, e);
        o.onEvent(e);
      }
      from = to + 1n;
      cursor = from;
    }
    for (const e of seen.values()) {
      if (!e.final && latest - e.blockNumber >= 2n) {
        e.final = true;
        o.onEvent(e);
      }
    }
  }

  (async function loop() {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        console.warn("poller", err);
      }
      await new Promise((r) => setTimeout(r, o.intervalMs ?? 1000));
    }
  })();
  return () => {
    stopped = true;
  };
}
