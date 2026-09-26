#!/usr/bin/env bash
# Full local rehearsal of the Custody stack: anvil (chain id 10143, anvil's Monad config) → deploy →
# register demo parties → e2e demo through the relay core → event poller check.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=${PORT:-8546}
TSX="npx --yes tsx@4"
# anvil's well-known dev keys (local only)
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
R1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
R2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
anvil --chain-id 10143 --port "$PORT" --silent &
ANVIL=$!; trap 'kill $ANVIL' EXIT; sleep 1.5
export RPC_URL="http://127.0.0.1:$PORT"
cd "$ROOT/contracts"
ADDR=$(forge create src/Custody.sol:Custody --rpc-url "$RPC_URL" --private-key "$DEPLOYER" --broadcast 2>/dev/null | awk '/Deployed to/{print $3}')
echo "Custody deployed at $ADDR (LOCAL)"
cd "$ROOT/soteria-frontend"
CONTRACT_ADDRESS=$ADDR DEPLOYER_KEY=$DEPLOYER PARTIES_OUT=/dev/null $TSX scripts/custody/setup.ts
CONTRACT_ADDRESS=$ADDR RELAYER_KEYS="$R1,$R2" $TSX scripts/custody/e2e.ts
cast rpc anvil_mine 3 --rpc-url "$RPC_URL" >/dev/null
CONTRACT_ADDRESS=$ADDR FROM_BLOCK=0 SECONDS=3 $TSX scripts/custody/watch.ts | grep -c "^final" | xargs echo "final events seen by the poller:"
