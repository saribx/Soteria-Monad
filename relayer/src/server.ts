// Relayer: runs the simulated devices, the scenario timelines and the keeper,
// and streams live telemetry to the dashboard (Server-Sent Events).
//
//   GET  /api/stream   hello, state, samples (4 Hz), tx, finality, log
//   POST /api/live | /api/s1 | /api/s3 | /api/storm | /api/reset
import { createServer, type ServerResponse } from 'node:http';
import { DEMO, LIVE_MINUTES, NETWORK, PORT, SPEND_CAP_MON } from './config.js';
import { onLogs, onTx, refreshFees, setRailAddress, type TxEvent } from './chain.js';
import { readDeployments } from './deployments.js';
import { followFinality } from './finality.js';
import { Demo, plain } from './scenarios.js';

const CONTROL_TOKEN = process.env.CONTROL_TOKEN;
const log = (m: string) => console.log(`${new Date().toLocaleTimeString('en-GB')}  ${m}`);

const deployment = readDeployments()[NETWORK.name];
if (!deployment) {
  console.error(`No deployment for ${NETWORK.name}. Run: npm run setup`);
  process.exit(1);
}
setRailAddress(deployment.rail);

const clients = new Set<ServerResponse>();
const broadcast = (event: string, data: unknown) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
};

let stateQueued = false;
const demo = new Demo(
  deployment.rail,
  () => {
    if (stateQueued) return;
    stateQueued = true;
    setTimeout(() => {
      stateQueued = false;
      broadcast('state', demo.snapshot());
    }, 60);
  },
  log,
);

const hello = () => ({
  network: NETWORK.name,
  chainId: NETWORK.chainId,
  ws: NETWORK.ws,
  http: NETWORK.rpc[0].url,
  explorer: NETWORK.explorer,
  rail: deployment.rail,
  teur: deployment.teur,
  spendCapMon: SPEND_CAP_MON,
  controlProtected: !!CONTROL_TOKEN,
  demo: DEMO,
});

// ---- telemetry at 4 Hz

const dt = 1 / DEMO.sample_hz;
setInterval(() => {
  const now = Date.now();
  const d: Record<string, number[]> = {};
  for (const device of demo.devices.values()) {
    const s = device.tick(now, dt);
    if (!s) continue;
    d[device.id.key] = [
      Math.round(s.temp * 100) / 100,
      Math.round(s.pressure * 1000) / 1000,
      Math.round(s.shock * 100) / 100,
      Math.round(s.speed * 10) / 10,
      device.escalated ? 1 : 0,
    ];
  }
  if (Object.keys(d).length) broadcast('samples', { t: now, d });
}, 1000 / DEMO.sample_hz);

// ---- transactions, logs and finality

onTx((tx: TxEvent) => {
  broadcast('tx', tx);
  if (tx.ok === false) log(`✗ ${tx.label}: ${tx.error ?? 'reverted'}`);
  else if (tx.latencyMs !== undefined && !tx.label.startsWith('report')) log(`✓ ${tx.label}  block ${tx.block}  ${tx.latencyMs} ms`);
});
onLogs(logs =>
  broadcast(
    'log',
    logs.filter(l => l.eventName !== 'Reading').map(l => ({ name: l.eventName, args: plain(l.args), tx: l.transactionHash, block: l.blockNumber })),
  ),
);
followFinality(deployment.rail, u => broadcast('finality', u), log);

setInterval(() => void refreshFees(), 15_000);
void refreshFees();

// ---- HTTP

const actions: Record<string, () => Promise<void>> = {
  '/api/live': () => demo.goLive(),
  '/api/s1': () => demo.runS1(),
  '/api/s3': () => demo.runS3(),
  '/api/storm': () => demo.runStorm(),
  '/api/reset': () => demo.reset(),
};

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-control-token, content-type');
  // Lets the deployed dashboard (https://…vercel.app) reach this relayer on localhost
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = req.url?.split('?')[0] ?? '/';
  if (url === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify(hello())}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(demo.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...hello(), state: demo.snapshot() }));
    return;
  }
  const action = actions[url];
  if (action && req.method === 'POST') {
    // Anyone may watch; only the holder of CONTROL_TOKEN may spend MON
    if (CONTROL_TOKEN && req.headers['x-control-token'] !== CONTROL_TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"control token required"}');
      return;
    }
    log(`control ${url}`);
    lastControl = Date.now();
    void action().catch(e => log(`${url} failed: ${e instanceof Error ? e.message : e}`));
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '::', () => {
  log(`relayer on http://localhost:${PORT}  network ${NETWORK.name}  rail ${deployment.rail}`);
  log(`spend cap ${SPEND_CAP_MON} MON · auto-stop ${LIVE_MINUTES ? `${LIVE_MINUTES} min` : 'off'} · RPC ${NETWORK.rpc.map(e => new URL(e.url).host).join(', ')}`);
});

// Budget and device counters change with every reading: refresh them each second
setInterval(() => {
  if (demo.live || demo.busy) broadcast('state', demo.snapshot());
}, 1_000);

// A live demo on a paid network must not keep burning MON when nobody watches
let lastControl = Date.now();
if (LIVE_MINUTES > 0) {
  setInterval(() => {
    if (demo.live && Date.now() - lastControl > LIVE_MINUTES * 60_000) {
      log(`no control action for ${LIVE_MINUTES} min: closing the demo`);
      lastControl = Date.now();
      void demo.reset();
    }
  }, 10_000);
}

// keep the SSE connections alive through proxies
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 15_000);

