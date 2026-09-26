#!/usr/bin/env bash
# Runs the whole demo on this machine against Monad testnet:
#   relayer (SoteriaRail scenarios, 4 Hz devices)  → http://localhost:8787
#   frontend (map dashboard + /sensors.html)      → http://localhost:5173
# Needs: relayer/.env (MONAD_NETWORK=testnet, FUNDER_PRIVATE_KEY, CONTROL_TOKEN, …) and relayer/.keys/testnet.json
#        from `cd relayer && npm run setup`; SENSOR_GATEWAY_KEY and VITE_MAPBOX_ACCESS_TOKEN in the shell or
#        soteria-frontend/.env.local. Public version: https://soteria-monad.vercel.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOKEN=$(grep '^CONTROL_TOKEN=' "$ROOT/relayer/.env" 2>/dev/null | cut -d= -f2 || true)
(cd "$ROOT/relayer" && [ -d node_modules ] || npm ci --silent) || true
(cd "$ROOT/soteria-frontend" && [ -d node_modules ] || npm ci --silent) || true
lsof -ti :8787 :5173 2>/dev/null | xargs kill 2>/dev/null || true
(cd "$ROOT/relayer" && npm start > "$ROOT/relayer.log" 2>&1 &)
sleep 4
(cd "$ROOT/soteria-frontend" && VITE_RELAYER_URL=http://localhost:8787 npx vite --port 5173 --strictPort > "$ROOT/frontend.log" 2>&1 &)
sleep 4
echo "relayer:   http://localhost:8787/api/hello   (log: relayer.log)"
echo "dashboard: http://localhost:5173/${TOKEN:+?control=$TOKEN}"
echo "sensors:   http://localhost:5173/sensors.html"
echo "stop:      lsof -ti :8787 :5173 | xargs kill"
