// Follows our contract's logs over WebSocket. On Monad `monadLogs` reports every
// log again as its block moves Proposed -> Voted -> Finalized, which is how the
// dashboard can say "final after 0.8 s". Plain `logs` (local anvil) only has
// the first stage.
import type { Address, Hex } from 'viem';
import { NETWORK } from './config.js';

export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';

export interface FinalityUpdate {
  hash: Hex;
  state: CommitState;
  at: number;
  block: number;
}

export function followFinality(address: Address, onUpdate: (u: FinalityUpdate) => void, log: (m: string) => void) {
  const seen = new Set<string>();
  let kind: 'monadLogs' | 'logs' = 'monadLogs';
  let socket: WebSocket | undefined;
  let closed = false;

  const connect = () => {
    socket = new WebSocket(NETWORK.ws);
    socket.onopen = () => {
      socket!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [kind, { address }] }));
    };
    socket.onmessage = ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1 && msg.error) {
        if (kind === 'monadLogs') {
          kind = 'logs';
          socket!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [kind, { address }] }));
        } else {
          log(`log subscription failed: ${msg.error.message}`);
        }
        return;
      }
      if (msg.id === 1) {
        log(`following ${kind} on ${NETWORK.ws}`);
        return;
      }
      const r = msg.params?.result;
      if (!r?.transactionHash) return;
      const state: CommitState = r.commitState ?? 'Proposed';
      const key = `${r.transactionHash}:${state}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 20_000) seen.clear();
      onUpdate({ hash: r.transactionHash, state, at: Date.now(), block: Number(BigInt(r.blockNumber)) });
    };
    socket.onclose = () => {
      if (!closed) setTimeout(connect, 1_000);
    };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}
