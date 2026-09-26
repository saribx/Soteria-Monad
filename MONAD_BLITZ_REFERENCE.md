# Monad Blitz Berlin 2026 – Build Reference

---

## ⚠️ **WICHTIGSTE QUELLE: [https://docs.monad.xyz/llms-full.txt](https://docs.monad.xyz/llms-full.txt)** ⚠️

**Komplette Monad-Doku in einer Datei, speziell für LLMs / AI Coding Assistants.**
**IMMER ZUERST HIER NACHSCHAUEN, bevor Annahmen über Monad getroffen werden (RPC, Chain-ID, Tooling, Precompiles, Gas etc.).**

---

## Hackathon-Regeln (hart)

1. **Kompletter Code wird heute geschrieben.** Keine bestehenden eigenen Projekte. Standard-Libraries sind ok.
2. **Live-Deployment Pflicht.** Funktionierender, öffentlich erreichbarer Demo-Link. Nur lokal gehostet = Disqualifikation.
3. **Öffentliches GitHub-Repo.**
4. **3-Minuten-Demo.** Slides optional, die Live-Demo zählt.

**Submission Freeze: 17:45 Uhr** – Einreichungsreihenfolge = Pitch-Reihenfolge.

## Fokus

- ✅ Neue Mechaniken, originelle Ideen, Monads Limits ausreizen (Speed, Throughput, Parallelität)
- ❌ Kein Aufwand in perfektes UI/UX, lange Feature-Listen oder Slides

Bewertung: 50% Jury + 50% Teilnehmer-Votes. Kriterien: innovativ, technisch interessant, inspirierend.

## Monad Kurzprofil

- Voll EVM-kompatibles L1 – bestehendes Solidity läuft unverändert
- Blockzeit **0,3 s**, Finality **0,6 s**, ~**10.000 TPS**
- Asynchronous Execution, Optimistic Parallel Execution, MonadDB, MonadBFT, JIT

## Monad-spezifische Dev-Features

- **128 KB Contract-Size-Limit** (4× Ethereum) – kein Proxy-Splitting nötig
- **`eth_sendRawTransactionSync`** – liefert den vollen Receipt synchron zurück → UI fühlt sich sofort an, keine Async-Confirm-Patterns
- **Execution Events** – Events direkt vom Node streamen, ohne Indexer
- MIP-8 (kommend): günstigerer Cold-Slot-Access

## Tooling

- **Viem ≥ 2.40** – native Monad Testnet- & Mainnet-Support
- **Monad Foundry** (Foundry-Fork mit Monad-Precompiles, Trace-Decoding, korrektem Gas in Simulation):
  ```bash
  curl -L https://foundry.category.xyz | bash
  ```
- Ecosystem vorhanden: Oracles (u.a. Chainlink, Pyth), Wallets (u.a. MetaMask), RPC-Provider → nicht selbst bauen

## Agentic Payments

- **x402** (HTTP 402 Micropayments) – kostenloser Facilitator von Monad
  - Guide: https://docs.monad.xyz/guides/x402-guide
  - Facilitator URL: `https://x402-facilitator.molandak.org`
  - Ablauf: Client fragt Resource an → Server antwortet 402 + JSON-Payment-Requirement → Client signiert Payment-Authorization (keine Onchain-Tx vom Client) → Server verifiziert & liefert → Facilitator settled onchain und zahlt Gas
- **MPP** (Machine Payments Protocol) – ERC-20 One-Time-Payments
  - Package: `@monad-crypto/mpp`

## Links

| Zweck | Link |
|---|---|
| **LLM-Doku (Hauptreferenz)** | **https://docs.monad.xyz/llms-full.txt** |
| Developer Essentials | https://docs.monad.xyz/developer-essentials |
| x402 Guide | https://docs.monad.xyz/guides/x402-guide |
| Developer Portal | https://developers.monad.xyz |
| GitHub | https://github.com/monad-developers |
| Tokens, Submission, Voting | https://blitz.devnads.com |
| Validator/Live-Chain-Ansicht | https://gmonads.com |
