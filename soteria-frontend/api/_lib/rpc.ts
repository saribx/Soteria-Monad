// Rate-limited, round-robin JSON-RPC transport. Public Monad testnet RPCs cap each client (testnet-rpc.monad.xyz:
// 15 req/s, and a JSON-RPC batch counts every call), so spread calls over several endpoints at RPC_RPS each.
import { custom, keccak256, RpcRequestError, type Hex } from "viem";

// dRPC's public Monad endpoint was dropped: it rejects eth_sendRawTransaction and caps eth_call gas.
export const TESTNET_RPCS = ["https://testnet-rpc.monad.xyz", "https://rpc.ankr.com/monad_testnet"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMITED = /limit|rate|too many|exceeded|capacity|not available|does not exist|unknown block|range is too large/i;

export function roundRobin(urls: string[], rps = Number(process.env.RPC_RPS ?? "8")) {
  const eps = urls.map((url) => ({ url, next: 0 }));
  const gap = 1000 / rps;
  let id = 0;

  async function slot() {
    const ep = eps.reduce((a, b) => (a.next <= b.next ? a : b));
    const now = Date.now();
    const at = Math.max(now, ep.next);
    ep.next = at + gap;
    if (at > now) await sleep(at - now);
    return ep;
  }

  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      let lastError = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        const ep = await slot();
        const body = { jsonrpc: "2.0", id: ++id, method, params };
        let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        try {
          const res = await fetch(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          json = (await res.json()) as typeof json;
        } catch (e) {
          lastError = (e as Error).message;
          ep.next = Date.now() + 1000;
          continue;
        }
        if (json.error) {
          // a retried broadcast that another endpoint already accepted
          if (method === "eth_sendRawTransaction" && /already known|known transaction|already imported/i.test(json.error.message)) {
            return keccak256((params as Hex[])[0]);
          }
          if (LIMITED.test(json.error.message) || [-32005, -32007, -32011, 429].includes(json.error.code)) {
            lastError = `${ep.url}: ${json.error.message}`;
            ep.next = Date.now() + 1000;
            continue;
          }
          throw new RpcRequestError({ body, error: json.error, url: ep.url });
        }
        return json.result;
      }
      throw new Error(`RPC unavailable for ${method} after retries (${lastError})`);
    },
  });
}
