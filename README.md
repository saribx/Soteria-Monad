# Soteria on Monad

Real-time monitoring of freight trains with automatic compensation. Wagons with
sensitive cargo report their sensors to Monad. When the cold chain breaks or a train
runs late, the contract compensates the cargo owner within a second, without a claim
form or a dispute. Nobody triggers the payment, and nobody can stop it.

**Before:** damage → report → assessment → dispute → paid after months.
**Now:** the sensor reading is the claim, and the block that records it settles it.

## Why a blockchain, why Monad

- **Neutral record.** Today the carrier, which is the liable party, holds the sensor
  data. On chain, no party can change a reading afterwards.
- **Self-executing, pre-funded.** The payout rule is agreed at booking, and the
  carrier's bond sits in the contract.
- **Monad makes it practical:**
  - Payouts are final in 0.6 s on L1.
  - Each wagon writes only its own storage slot, so a whole corridor switching to
    1 Hz at once executes in parallel without conflicts.
  - A reading costs ~0.006 MON.
  - It is plain Solidity.
  - The dashboard reads the contract's events straight from the node (`monadLogs`,
    Proposed → Finalized), with no indexer.

| | Final after | Bursts | EVM |
|---|---|---|---|
| Ethereum | ~13 min | ~15–30 TPS network-wide | ✅ |
| L2 (Base, Arbitrum) | Final only once Ethereum settles | good | ✅ |
| Solana | seconds | very good | ❌ |
| **Monad** | **0.6 s** | **~10k TPS, parallel** | ✅ |

## Sensors only where needed

| Cargo | Sensor | On chain |
|---|---|---|
| frozen food, pharmaceuticals (reefer) | temperature | automatic compensation per second out of range |
| hazardous liquid (tank) | pressure, temperature, shock | timestamped `SafetyAlert`, no payout |
| general goods | none | nothing |
| locomotive | speed | standstill and arrival → delay |

In the demo, 6 of 16 wagons carry sensors, plus 2 locomotives. Devices sample at
4 Hz. What goes on chain:

- **Heartbeat:** every 10 s, carrying min, max and last value for the window.
- **1 Hz:** near a threshold or after an impact, for as long as it can still change
  money.
- **Silence:** a monitored wagon that goes silent counts as out of range.

## Settlement rules (`contracts/src/SoteriaRail.sol`)

| Event | Settlement |
|---|---|
| Temperature out of range, after a grace period | Accrues per second and is paid automatically when the excursion ends or the wagon cap is reached |
| Standstill beyond the slack, or deadline missed | Delay penalty accrues and is paid after a challenge window. The carrier can dispute (force majeure) |
| Tank pressure drop or impact | `SafetyAlert` with a timestamp: proof of timely notification, no payout |
| Damage without a sensor, disputed delay | Soteria decision + receipt hash, paid from the carrier's liability pool once both parties sign |

The bond covers only the automatic exposure. Larger claims come from a fleet-wide
pool, up to the liability cap from `data/contracts/`. Money is `tEUR`, a demo token
with no value. No place, company or goods name goes on chain.

## Run it

**Local (free, same flow as mainnet)**. Needs [Monad Foundry](https://docs.monad.xyz)
(`curl -L https://foundry.category.xyz | bash && foundryup --network monad`) and Node 22+.

```shell
cd contracts && forge install foundry-rs/forge-std --no-git && forge test   # 22 tests
cd ../relayer && npm install
npm run chain        # terminal 1: local Monad chain (anvil --network monad, 0.3 s blocks)
npm run setup        # deploy, mint tEUR, fund keys
npm start            # terminal 2: devices, scenarios, keeper on :8787
cd ../soteria-frontend && npm install && npm run dev   # terminal 3: dashboard
```

**Mainnet** (after the local steps above, so the contracts are compiled)

1. Create `relayer/.env` with:
   ```shell
   MONAD_NETWORK=mainnet
   FUNDER_PRIVATE_KEY=0x…   # the wallet with the 50 MON; never commit
   ```
2. Run `npm run setup` once. It deploys and parks ~21 MON on the device, carrier and
   customer keys.
3. Run `npm start` for the pitch.
4. Run `npm run sweep` afterwards to return the parked MON.

## Demo runbook (3 min)

Everything is driven from the Monad panel on the right of the live map. Press **D**
to hide the buttons.

1. **Go live.** Both shipments are booked and accepted on chain. Open **Fleet**:
   - Every monitored wagon streams at 4 Hz.
   - A purple dot marks each reading that landed on Monad.
   - General-goods wagons show "No sensor".
2. **s1 · Reefer failure** (Donner Pass, 11 °C outside):
   - An impact damages the W02 unit.
   - The air warms past −15 °C and the device switches to 1 Hz.
   - An excursion opens on chain and the € counter runs.
   - Soteria's decision ("Cool cargo") is anchored and backup cooling kicks in.
   - The excursion ends and Frischemarkt is paid, final in under a second.
3. **s3 · Storm tree** (Berlin Hbf, 12 °C, storm):
   - Emergency stop: the hazmat tank W05 raises a shock alert, then a pressure alert.
   - The pharma unit W02 is torn off: from +5 °C it passes +8 °C and accrues €400/s
     up to its €12,000 cap.
   - The standstill costs the delivery slot: a €9,000 delay accrues.
   - The carrier disputes (force majeure).
   - Soteria assesses the damage to W03, which has no sensor. Chemiewerk signs:
     €24,000 is paid from the pool and the delay is waived.
4. **Storm burst:** 50 wagons on the corridor switch to 1 Hz at once, ~1,500 readings
   in 30 s. The readings/s spike while the latency stays flat.

## Cost and safeguards

Gas below was measured on Monad Foundry's anvil. Monad charges the gas limit, so every
path has its own tight limit:

| Path | Gas used | Limit |
|---|---|---|
| reefer reading in range | 52k | 58k |
| reefer reading, excursion open | 61k | 67k |
| reefer reading, excursion settles | 138k | 152k |
| tank / locomotive reading | 60k | 67k |

At the 100 gwei minimum base fee a reading costs ~0.006 MON (~$0.0001). One full demo
(go live, s1, s3, storm, a few minutes of heartbeats) costs **~13 MON**; ~9 MON of that
is the storm.

**Plan for the 50 MON:**

- setup ~0.5 MON
- one mainnet dry run ~13 MON
- the pitch ~13 MON
- the rest in reserve

Rehearse on the local chain; it is free.

**Safeguards:**

- **Spending cap per relayer run:** `MAX_MON_SPEND`, default 16 on mainnet. The
  relayer stops sending when it is reached.
- **Auto-stop:** a live demo closes itself after 15 min without a click.
- **Gas calibration:** at go live, free `eth_estimateGas` calls scale the limits to
  the network's pricing (MIP-8). A reading that still runs out of gas raises its
  limit by 30%.
- **Simulation first:** every non-reading transaction is simulated before it is
  sent, because a revert on Monad still pays its gas limit.

## Layout

| Path | What |
|---|---|
| `contracts/` | `SoteriaRail.sol`, `TEUR.sol`, tests (Foundry, `osaka`) |
| `relayer/` | simulated devices (`physics.ts`), scenario timelines and keeper (`scenarios.ts`), rate-limited RPC pool with budget (`chain.ts`), SSE server (`server.ts`) |
| `data/monad/demo.json` | which wagons are monitored, thresholds, rates, demo timings (shared by relayer and dashboard) |
| `soteria-frontend/src/chain/` | live store: relayer stream + direct Monad WebSocket |
| `soteria-frontend/src/components/chain/` | Monad panel, fleet sensor tiles, contract card, toasts |

## Limits

- **Sensors are simulated.** The temperatures, pressures and places are realistic.
  How fast a failed unit warms, and the grace, slack and challenge windows, are
  compressed for the demo.
- **Public RPCs are rate limited** (15–30 rps each). The relayer spreads load over
  five endpoints and stays under their limits. The storm is capped by the RPCs, not
  by the chain.
- **Device keys are agreed at booking.** Hardware attestation is out of scope; a
  device that goes silent is covered by the gap rule.
