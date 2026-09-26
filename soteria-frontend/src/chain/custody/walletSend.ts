// Alternative to the relay: the viewer's own browser wallet (MetaMask, Rabby, …) sends the transaction
// and pays gas from its own address. The P-256 party signatures inside the call are unchanged, so the
// contract checks exactly the same thing. Costs: one wallet popup per action and MON on the viewer's account.
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { custodyAbi } from "./abi.js";
import { makePublicClient, monad } from "./client.js";
import { revertReason } from "./errors.js";
import type { Op, RelayResult } from "./types.js";

export type ConnectedWallet = { wallet: WalletClient; address: Address };

export async function connectWallet(): Promise<ConnectedWallet> {
  const eth = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or Rabby, or send through the relay.");
  const wallet = createWalletClient({ chain: monad, transport: custom(eth) });
  const [address] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: monad.id });
  } catch {
    await wallet.addChain({ chain: monad }); // wallet has never seen chain 10143
    await wallet.switchChain({ id: monad.id });
  }
  return { wallet, address };
}

/** Simulates first (no popup for a rejection), then asks the wallet to send. Same result shape as the relay. */
export async function sendViaWallet(
  w: ConnectedWallet, contract: Address, op: Op, args: readonly unknown[], rpcUrl?: string,
): Promise<RelayResult> {
  const pub = makePublicClient(rpcUrl);
  const tStart = Date.now();
  let gas: bigint;
  try {
    const est = await pub.estimateContractGas({ address: contract, abi: custodyAbi, functionName: op, args: args as never, account: w.address });
    gas = (est * 125n) / 100n;
  } catch (e) {
    const reason = revertReason(e);
    if (reason) return { ok: false, rejected: true, reason };
    return { ok: false, rejected: false, error: (e as Error).message.split("\n")[0] };
  }
  const simMs = Date.now() - tStart;
  const t0 = Date.now(); // includes the time the viewer spends on the wallet popup
  try {
    const hash = await w.wallet.writeContract({
      address: contract, abi: custodyAbi, functionName: op, args: args as never, gas, account: w.address, chain: monad,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (receipt.status !== "success") return { ok: false, rejected: false, error: `reverted on-chain: ${hash}` };
    return {
      ok: true, hash, blockNumber: receipt.blockNumber.toString(), ms: Date.now() - t0, simMs,
      totalMs: Date.now() - tStart, gasUsed: receipt.gasUsed.toString(),
    };
  } catch (e) {
    return { ok: false, rejected: false, error: (e as Error).message.split("\n")[0] };
  }
}
