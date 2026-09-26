# Custody layer (P-256): who had it?

**The trust layer for things in motion.** Every handover of freight is a transaction signed by both sides.
Every sensor reading is signed by the wagon's own P-256 key and verified on-chain. When a shock breaks the
agreed limit, the company holding the goods in that custody period pays the shipper in the same block.

Built at Monad Blitz Berlin, 26 Sep 2026, on Monad testnet (chain id 10143).

## What is on-chain, what is simulated, what is reused

| Part | Status |
|---|---|
| `Custody.sol`: parties, shipments, handovers, sealed batches, alarms, tEUR settlement | **On-chain**, written today |
| P-256 signature checks (EIP-7951 precompile at `0x0100`) | **On-chain**, every write |
| Party and wagon keys | Real WebCrypto P-256 keys. **In the demo one page holds every party's key** (published with the dashboard), so "both sides signed" is shown, not independently performed |
| Wagon sensors | **Simulated in the browser**, signing with real keys ("simulated sensor, real signature") |
| Relay (`/api/relay`) | Written today. Pays gas, simulates first, holds no party keys. Viewers can instead send from their own wallet (`walletSend.ts`) |
| tEUR | Test balance inside the contract, minted by the owner. Not money |
| Encryption of readings | Contract side built (ciphertext, running hash, wrapped keys). Browser encryption not built yet |
| Train movement on the map | Illustrative. Custody, alarms and money come only from contract events |
| 3D map frontend | Existing Soteria visualization, adapted today |

## The protocol

| Layer | Call | Who signs |
|---|---|---|
| Identity | `registerParty(x, y, role, name)` | owner (demo allowlist, not accreditation) |
| Custody | `createShipment(id, terms, wagonKeys, sig)` | shipper |
| Custody | `handover(id, epoch, to, reservation, expiry, giverSig, receiverSig)` | current holder **and** receiver |
| Evidence | `commitBatch(id, wagon, epoch, seq, root, status, ciphertext, sig)` | wagon key; covers `sha256(ciphertext)` |
| Settlement | `alarm(id, epoch, wagon, alarmId, kind, valueCg, sig)` | wagon key; charges the holder of that epoch |
| Privacy | `postKeys(id, epoch, signer, partyKeys, wrapped, sig)` | shipper or holder |

Signed message = `abi.encodePacked(chainId, contract, op, …fields)`. The contract runs `sha256` once and calls
`0x0100`; the browser signs the same raw bytes with `crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"})`.
Rejections: `NotVerified` (unknown key), `BadSignature` (forgery), `StaleEpoch`, `Replay`, `BelowLimit`, `Delivered`.

`head[id] = keccak256(head, root, sha256(ciphertext))` is one storage slot that commits to a shipment's whole history.

## Limits we state openly

- Chain order proves when something was published, not when it physically happened.
- Ciphertext on a public chain is permanent. A leaked key later exposes the data.
- A party can leak its own decrypted copy. The chain proves what was sent, not who leaked it.
- Sensors can fail or lie. Heartbeat rules and 2-of-3 sensor agreement are next, not built today.

## Run it

```bash
cd contracts && forge test --match-contract CustodyTest     # 25 tests (needs forge-std in contracts/lib)
contracts/tools/custody-local.sh                           # full demo on a local anvil, chain id 10143
contracts/tools/custody-deploy-testnet.sh                  # Monad testnet, reads .env.custody
```

Scripts run with `npx tsx@4`; typecheck with `npx tsc -p soteria-frontend/tsconfig.custody.json` (needs `@types/node`).

## How this relates to SoteriaRail

This branch adds `Custody.sol` next to `SoteriaRail.sol` and changes nothing in the existing contract, relayer or
dashboard. SoteriaRail trusts device *addresses* whose keys the relayer server holds. Custody checks a P-256
signature per wagon and per party on-chain (precompile `0x0100`), and custody changes need both sides' signatures.
Which one the demo shows is a team decision; see the table at the top.


## 1. Where things are (already in place on this branch)

| What | Path |
|---|---|
| Contract + 25 tests (golden WebCrypto vector inside) | `contracts/src/Custody.sol`, `contracts/test/Custody.t.sol` |
| Browser modules | `soteria-frontend/src/chain/custody/` |
| Demo party keys (public on purpose) | `soteria-frontend/src/chain/custody/demo/demo-keys.json` |
| Vercel function | `soteria-frontend/api/relay.ts` (core in `api/_lib/relay.ts`) |
| Node scripts | `soteria-frontend/scripts/custody/` (setup, e2e, watch) |
| Tools | `contracts/tools/custody-local.sh`, `custody-deploy-testnet.sh`, `custody-abi.mjs`, `custody-golden.mjs` |

viem is already a dependency. Relative imports end in `.js` (resolves to the `.ts` file in Vite, tsx and Vercel functions alike).

Vercel env: `RPC_URL`, `RELAYER_KEYS`, `CONTRACT_ADDRESS` (server), `VITE_CONTRACT_ADDRESS` (browser).
Values are in `.env.custody` at the repo root (gitignored).

## 2. Keys (browser)

```ts
import demo from "./chain/custody/demo/demo-keys.json";
import { importJwk, sign } from "./chain/custody/keys.js";
const K = Object.fromEntries(await Promise.all(demo.map(async (e) => [e.slot, await importJwk(e.jwk)])));
// K.shipper, K.carrierA, K.carrierB, K.receiver, K.wagon0 … K.wagon4  → { privateKey, x, y, key }
```

## 3. Buttons → signed ops

```ts
import { sendOp } from "./chain/custody/relayClient.js";
import * as M from "./chain/custody/messages.js";
const ctx = { chainId: 10143, contract: import.meta.env.VITE_CONTRACT_ADDRESS };
const now = () => BigInt(Math.floor(Date.now() / 1000));

// Create
const id = BigInt(Date.now());
const terms = { shipper: K.shipper.key, carrier: K.carrierA.key, receiver: K.receiver.key,
                penalty: 25_000n, cap: 40_000n, shockLimitCg: 300, expiry: now() + 600n };
const wagons = [0,1,2,3,4].map((i) => K[`wagon${i}`].key);
await sendOp("createShipment", [id, terms, wagons, await sign(K.shipper, M.createMessage(ctx, id, terms, wagons))]);

// Hand over (epoch = current epoch, from the Handover events)
const exp = now() + 120n, res = "0x" + "00".repeat(32);
const hm = M.handoverMessage(ctx, id, epoch, K.carrierA.key, K.carrierB.key, res, exp);
await sendOp("handover", [id, epoch, K.carrierB.key, res, exp, await sign(K.carrierA, hm), await sign(K.carrierB, hm)]);

// Shock (valueCg 520 = 5.20 g; limit is 300). alarmId must be unique per shipment.
await sendOp("alarm", [id, epoch, 0, alarmId, M.KIND_SHOCK, 520,
  await sign(K.wagon0, M.alarmMessage(ctx, id, epoch, 0, alarmId, M.KIND_SHOCK, 520))]);

// Forge: sign wagon 0's batch with the WRONG key  → { ok:false, rejected:true, reason:"BadSignature" }
// Stranger: createShipment with (await generateKey()).key as shipper → reason "NotVerified"
// Batch: M.batchMessage(ctx, id, wagon, epoch, seq, root, status, ciphertext), seq strictly increasing per wagon
```

`sendOp` returns `{ ok:true, hash, blockNumber, ms, gasUsed }` or `{ ok:false, rejected:true, reason }`.
Rejections are contract simulations: nothing is sent, no gas is spent. Show them as "rejected by the contract: <reason>".

## 4. Feed → map

```ts
import { startPoller } from "./chain/custody/events.js";
startPoller({ contract: ctx.contract, onEvent: (e) => { /* e.name, e.args, e.blockNumber, e.txHash, e.final */ } });
```

| Event | Drive |
|---|---|
| `ShipmentCreated` | new train, wagons, terms |
| `Handover` | holder of `id` = `to`, epoch = `epoch` (also emitted at create, epoch 1) |
| `Batch` | status light per wagon (0 green, 1 amber, 2 red) |
| `Alarm` | wagon red, money: `holder` −`penalty`, shipper +`penalty` (tEUR cents) |
| `Funded` | carrier balances at start |

Pending → final after 2 blocks. Explorer link: `explorerTx(hash)` from `client.ts`.

## 5. Two ways to send: relay (default) or the viewer's wallet

| | Relay (`relayClient.ts` → `/api/relay`) | Wallet (`walletSend.ts`) |
|---|---|---|
| Who pays gas | our relayer accounts | the viewer's own address |
| Popups | none | one per action |
| Needs | nothing | MetaMask/Rabby + testnet MON |
| On the explorer, `from` = | relayer address | viewer's address |
| What the contract checks | the P-256 party signature in the call | the same P-256 signature |

Both are real Monad transactions. Use the relay on stage. Offer "Send with my wallet" as a toggle for judges:
`const w = await connectWallet(); await sendViaWallet(w, contract, "alarm", args)`. Same result shape as `sendOp`.

## 6. Labels the screen must show (mock purge)

These are simulated in the demo. Each one needs its label **on screen**, not only in the README:

| What | Label | Why |
|---|---|---|
| One browser holds every party's key | "Demo: this page holds all parties' keys. In production each company signs on its own device." | Otherwise "both carriers signed the handover" reads as two independent companies consenting |
| Wagon readings come from buttons | "Simulated sensor, real signature" on each wagon | Otherwise a shock reads as a measured event |
| Train position | "Position illustrative" on the map | Movement is animation; only custody, alarms and money come from events |
| tEUR | "test EUR, minted by the demo owner" next to balances | Otherwise payouts read as real money |
| Party registration | "Demo allowlist" next to verified badges | Registration is the owner's call, not an accreditation |
| Supplier/Customer/Carrier view without encryption | "Plaintext demo, encryption not built yet" | Otherwise the privacy claim reads as working |
| Relay rejections | "Rejected by contract simulation, not sent" | Nothing reached the chain, so there is no tx hash to show |

Never show a tx hash, block number or explorer link that did not come from a receipt.
