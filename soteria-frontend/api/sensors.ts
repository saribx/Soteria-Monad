// Vercel function: POST /api/sensors  body {"trigger"?: "s1/W02/temp"}  → one real round of sensor transactions.
import { runRound } from "./_lib/sensors.js";

export async function POST(request: Request): Promise<Response> {
  let trigger: string | undefined;
  try {
    const body = (await request.json()) as { trigger?: string };
    trigger = typeof body.trigger === "string" && body.trigger ? body.trigger : undefined;
  } catch {
    /* empty body = a normal round */
  }
  const result = await runRound(process.env, trigger);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 409,
    headers: { "content-type": "application/json" },
  });
}
