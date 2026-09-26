// Relay core: simulate first, send only what the contract accepts.
// Holds relayer (gas) keys only. It never holds party or wagon keys: every op arrives already signed.
import {
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { custodyAbi } from "../../src/chain/custody/abi.js";
import { makePublicClient, monad } from "../../src/chain/custody/client.js";
import { revertReason } from "../../src/chain/custody/errors.js";

export { revertReason };

import { OPS, type Op, type RelayRequest, type RelayResult } from "../../src/chain/custody/types.js";

export { OPS, type Op, type RelayRequest, type RelayResult };

// Batches get their own relayer so the wagon stream never races the demo buttons for a nonce.
const LANE: Record<Op, number> = { commitBatch: 1, createShipment: 0, handover: 0, alarm: 0, postKeys: 0 };
const GAS_CAP = 2_000_000n;

export type RelayConfig = { rpcUrl: string; relayerKeys: Hex[]; contract: Address };

export function configFromEnv(env: Record<string, string | undefined> = process.env): RelayConfig {
  const rpcUrl = env.RPC_URL ?? monad.rpcUrls.default.http[0];
  const relayerKeys = (env.RELAYER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean) as Hex[];
  const contract = env.CONTRACT_ADDRESS as Address | undefined;
  if (!relayerKeys.length) throw new Error("RELAYER_KEYS is empty");
  if (!contract) throw new Error("CONTRACT_ADDRESS is not set");
  return { rpcUrl, relayerKeys, contract };
}

export async function relay(cfg: RelayConfig, req: RelayRequest): Promise<RelayResult> {
  const tStart = Date.now();
  if (!OPS.includes(req.op)) return { ok: false, rejected: true, reason: `op not allowed: ${String(req.op)}` };

  const pub = makePublicClient(cfg.rpcUrl);
  const key = cfg.relayerKeys[LANE[req.op] % cfg.relayerKeys.length];
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: monad, transport: http(cfg.rpcUrl) });

  let data: Hex;
  try {
    data = encodeFunctionData({ abi: custodyAbi, functionName: req.op, args: req.args as never });
  } catch (e) {
    return { ok: false, rejected: true, reason: `bad args: ${(e as Error).message.split("\n")[0]}` };
  }

  // 1. One round trip: gas estimate (= contract simulation, decodes custom errors) with nonce and fees
  //    fetched in parallel. A rejection costs no gas and never reaches the chain.
  let gas: bigint, nonce: number, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    const [est, n, f] = await Promise.all([
      pub.estimateContractGas({ address: cfg.contract, abi: custodyAbi, functionName: req.op, args: req.args as never, account }),
      pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
      pub.estimateFeesPerGas(),
    ]);
    gas = (est * 125n) / 100n; // Monad charges the gas limit, so keep it tight.
    if (gas > GAS_CAP) gas = GAS_CAP;
    nonce = n;
    fees = { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
  } catch (e) {
    const reason = revertReason(e);
    if (reason) return { ok: false, rejected: true, reason };
    return { ok: false, rejected: false, error: (e as Error).message.split("\n")[0] };
  }
  const simMs = Date.now() - tStart;

  // 2. Fully specified tx, sent and confirmed in one call (eth_sendRawTransactionSync, returns at Proposed).
  const t0 = Date.now();
  try {
    const receipt = await wallet.sendTransactionSync({ to: cfg.contract, data, gas, nonce, ...fees });
    if (receipt.status !== "success") return { ok: false, rejected: false, error: `reverted on-chain: ${receipt.transactionHash}` };
    return {
      ok: true,
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      ms: Date.now() - t0,
      simMs,
      totalMs: Date.now() - tStart,
      gasUsed: receipt.gasUsed.toString(),
    };
  } catch (e) {
    const reason = revertReason(e);
    if (reason) return { ok: false, rejected: true, reason };
    return { ok: false, rejected: false, error: (e as Error).message.split("\n")[0] };
  }
}
