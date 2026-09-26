#!/usr/bin/env bash
# Monad testnet: top up relayers from the deployer → deploy Custody (unless CONTRACT_ADDRESS is set) →
# register demo parties + tEUR → run the full e2e demo. Reads/writes <repo>/.env.custody (gitignored):
#   RPC_URL, DEPLOYER_KEY, DEPLOYER_ADDRESS, RELAYER_KEYS, RELAYER_ADDRESSES, CONTRACT_ADDRESS
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVF="$ROOT/.env.custody"
set -a; source "$ENVF"; set +a
TSX="npx --yes tsx@4"
RELAYER_TARGET_MON=${RELAYER_TARGET_MON:-5}
bal(){ cast balance "$1" --rpc-url "$RPC_URL" --ether; }
echo "deployer $DEPLOYER_ADDRESS: $(bal $DEPLOYER_ADDRESS) MON"
for a in ${RELAYER_ADDRESSES//,/ }; do
  need=$(python3 -c "print(max(0, $RELAYER_TARGET_MON - float('$(bal $a)')))")
  if python3 -c "import sys; sys.exit(0 if $need > 0.01 else 1)"; then
    cast send "$a" --value "${need}ether" --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" >/dev/null
  fi
  echo "relayer $a: $(bal $a) MON"
done
if [ -z "${CONTRACT_ADDRESS:-}" ]; then
  cd "$ROOT/contracts"
  CONTRACT_ADDRESS=$(forge create src/Custody.sol:Custody --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast \
    | awk '/Deployed to/{print $3}')
  [ -n "$CONTRACT_ADDRESS" ] || { echo "deploy failed"; exit 1; }
  sed -i '' "s/^CONTRACT_ADDRESS=.*/CONTRACT_ADDRESS=$CONTRACT_ADDRESS/" "$ENVF"
  echo "Custody deployed at $CONTRACT_ADDRESS"
fi
export CONTRACT_ADDRESS
cd "$ROOT/soteria-frontend"
$TSX scripts/custody/setup.ts
$TSX scripts/custody/e2e.ts
