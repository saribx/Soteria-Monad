// Vercel function: POST /api/relay with body toJson({ op, args }).
// Env: RPC_URL, RELAYER_KEYS (comma-separated), CONTRACT_ADDRESS. Never commit them.
import { fromJson, toJson } from "../src/chain/custody/codec.js";
import { configFromEnv, relay, type RelayRequest } from "./_lib/relay.js";

export async function POST(request: Request): Promise<Response> {
  let req: RelayRequest;
  try {
    req = fromJson<RelayRequest>(await request.text());
  } catch {
    return new Response(toJson({ ok: false, rejected: true, reason: "body is not JSON" }), { status: 400 });
  }
  const result = await relay(configFromEnv(), req);
  const status = result.ok ? 200 : result.rejected ? 422 : 502;
  return new Response(toJson(result), { status, headers: { "content-type": "application/json" } });
}
