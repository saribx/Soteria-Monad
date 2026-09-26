# Sensor contracts: compensation paid in MON while the cargo is out of limits

One small contract per monitored wagon condition from `data/monad/demo.json`, deployed in advance as EIP-1167
copies (`contracts/src/SensorPayout.sol`). Each holds the carrier's bond in MON. Terms follow the case data:

| Condition | Goods | Limit | Grace | Compensation | Cap |
|---|---|---|---|---|---|
| s1/W02, s1/W05, s3/W04, s3/W07 · temp | frozen food | above −15 °C | 10 s | €20/s = 0.0002 MON/s | €6,000 = 0.06 MON |
| s3/W02 · temp | pharmaceuticals | above 8 °C | 10 s | €400/s = 0.004 MON/s | €12,000 = 0.12 MON |
| s3/W05 · pressure | hazardous liquid | below 3.8 bar | 0 s | lump sum | €9,000 = 0.09 MON (contract_k3 penalty) |
| s3/W05 · shock | hazardous liquid | above 2.0 g | 0 s | lump sum | €9,000 = 0.09 MON |

Demo scale: **1 MON stands for €100,000** (`EUR_PER_MON`). Amounts are illustrative; the mechanism is the point.

## The rule

1. The sensor gateway sends readings with `report(value)` (every 10th sample of a 4 Hz stream).
2. A reading past the limit starts an **excursion**, timed by the block clock. Nothing is paid during the grace period.
3. After the grace period, every reading pays `seconds out of limits × rate` in **MON to wallet 2 (customer)**,
   in the same transaction, up to the cap.
4. A reading back inside the limits ends the excursion; payments stop. The contract can be used again.
5. `deliver()` settles a running excursion and refunds the rest of the bond to **wallet 1 (carrier)**.

**Why Monad:** every sensor sends its own transaction at the same moment. Each copy has its own storage, so the
transactions don't conflict and run in parallel, and money moves per second while the incident is still happening.

## Live on Monad testnet

| | |
|---|---|
| Factory | [`0x32b3b3a8fa69ba86e6c20494af5199d7535e823f`](https://testnet.monadvision.com/address/0x32b3b3a8fa69ba86e6c20494af5199d7535e823f) |
| Sensor gateway (oracle, pays gas) | `0x626422741d45C6470d28b93C367DB405671DdC86` |
| Wallet 1 · carrier | `0xe59841AdB191937C04934189AC34f6A5e8FBeA2c` |
| Wallet 2 · customer | `0x610C0DD8eA0f80e29d942a5977BAf6429E6BC020` |

| Condition | Contract |
|---|---|
| `s1/W02/temp` | [`0xC84370c5442526EE74f6DF1a9c887ED85e908B1d`](https://testnet.monadvision.com/address/0xC84370c5442526EE74f6DF1a9c887ED85e908B1d) |
| `s1/W05/temp` | [`0x0Da1FC9845b1CB47629CB9F181486070A8a8A6F4`](https://testnet.monadvision.com/address/0x0Da1FC9845b1CB47629CB9F181486070A8a8A6F4) |
| `s3/W02/temp` | [`0x2aD99958386df7B4eC0A299077D75e795262b1c7`](https://testnet.monadvision.com/address/0x2aD99958386df7B4eC0A299077D75e795262b1c7) |
| `s3/W04/temp` | [`0xcf10f652b9d92D92A7138A352e8d2B290e35922D`](https://testnet.monadvision.com/address/0xcf10f652b9d92D92A7138A352e8d2B290e35922D) |
| `s3/W05/pressure` | [`0xd2A4c3Bd2C130952f868b7532aDb4A6f569234Fb`](https://testnet.monadvision.com/address/0xd2A4c3Bd2C130952f868b7532aDb4A6f569234Fb) |
| `s3/W05/shock` | [`0x7F51809e9FeD0d981a48293bD7C054B007CF611C`](https://testnet.monadvision.com/address/0x7F51809e9FeD0d981a48293bD7C054B007CF611C) |
| `s3/W07/temp` | [`0x46a7EC62d3Af72820275AC9981EA487CDD764f91`](https://testnet.monadvision.com/address/0x46a7EC62d3Af72820275AC9981EA487CDD764f91) |

First run (`data/payout-demo-testnet.log`): 98 readings in 27 s; the frozen-food and pharma wagons ran out of
limits, nothing was paid for 10 s, then 8 payments sent 0.0336 MON to wallet 2 (70.0000 → 70.0336 MON) until they
cooled down. `data/tx-dashboard.html` shows every transaction (regenerate with `collect.ts` + `dashboard.ts`).

An earlier all-or-nothing version paid tEUR (a test token) instead of MON; its transactions stay on-chain, e.g.
[0x4116…](https://testnet.monadvision.com/tx/0x4116f842d63a227eaf8336f0ff5a6fc27b3764c6016b95c9353446d70af5a459).

## What is real, what is simulated

| | |
|---|---|
| Transactions, contract checks, MON payments between the contracts and the wallets | **Real** (Monad testnet) |
| Sensor values | **Simulated** (4 Hz stream in `demo.ts` / `api/_lib/sensors.ts`); every 10th sample goes on-chain |
| Local runs (`NETWORK=local`) | Anvil; every tx line says "local tx … not on testnet" |

## Run

```bash
cd contracts && forge build && cd ../sensor-demo && npm i
# .env: NETWORK=testnet, SENSOR_GATEWAY_KEY (deploys, is the oracle, pays gas), WALLET_1 (carrier), WALLET_2 (customer)
npm run deploy     # 7 MON-funded contracts (0.54 MON bonds + ~0.3 MON gas)
npm run demo       # 14 rounds, 2 s apart; s1/W02 + s3/W02 overheat in rounds 3–11 (~1 MON gas)
npx tsx --env-file=.env collect.ts && npx tsx dashboard.ts    # transaction dashboard → data/tx-dashboard.html
```

Knobs: `ROUNDS`, `INTERVAL_MS`, `HOT_FROM`, `HOT_ROUNDS`, `TRIGGER`, `SAMPLE_EVERY`, `COPIES`, `EUR_PER_MON`,
`MAX_MON` (spend cap; the scripts refuse above it). Wallets 1 and 2 only receive.

**Public RPC limits:** testnet-rpc.monad.xyz allows 15 requests/s per client and 100-block log ranges.
`soteria-frontend/api/_lib/rpc.ts` spreads calls over the Monad RPC and Ankr; a keyed RPC (`RPC_URLS`, `RPC_RPS`)
raises the rate. The web version is `soteria-frontend/sensors.html` with `/api/sensors` (env `SENSOR_GATEWAY_KEY`).
