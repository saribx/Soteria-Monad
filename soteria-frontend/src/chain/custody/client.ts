import { createPublicClient, defineChain, http, type Address } from "viem";

export const monad = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
});

export const explorerTx = (hash: string) => `${monad.blockExplorers.default.url}/tx/${hash}`;

export function makePublicClient(rpcUrl: string = monad.rpcUrls.default.http[0]) {
  return createPublicClient({ chain: monad, transport: http(rpcUrl) });
}

export type ContractRef = { address: Address };
