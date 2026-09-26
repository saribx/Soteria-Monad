// Browser side of the relay: POST a signed op to /api/relay, get a receipt or a contract rejection.
import { fromJson, toJson } from "./codec.js";
import type { Op, RelayResult } from "./types.js";

export async function sendOp(op: Op, args: readonly unknown[], endpoint = "/api/relay"): Promise<RelayResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ op, args }),
  });
  return fromJson<RelayResult>(await res.text());
}
