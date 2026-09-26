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
  let failures = 0;

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
        failures = 0;
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
      if (closed) return;
      failures++;
      if (failures === 1 || failures % 30 === 0) log(`WebSocket ${NETWORK.ws} closed, reconnecting (${failures})`);
      setTimeout(connect, Math.min(30_000, 1_000 * failures));
    };
    // An error is always followed by close, which reconnects. Calling close()
    // here would re-enter this handler on Node 22 (undici) and overflow the stack.
    socket.onerror = () => undefined;
  };
  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}
