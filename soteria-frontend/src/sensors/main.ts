// Sensor contracts page. Everything shown is read from the chain (contract events, balanceOf, state);
// the buttons ask /api/sensors to send one real round of readings. Nothing is generated in the browser.
import { createPublicClient, decodeEventLog, formatEther, hexToString, http, parseAbi, type Address, type Hex } from "viem";
import dep from "./deployment.json";
import "./sensors.css";

const ABI = parseAbi([
  "event Reading(bytes32 indexed caseId, int32 value)",
  "event ExcursionStarted(bytes32 indexed caseId, int32 value, uint40 at)",
  "event Compensation(bytes32 indexed caseId, address indexed customer, uint256 amount, uint40 secondsPaid, uint256 totalPaid)",
  "event ExcursionEnded(bytes32 indexed caseId, int32 value, uint40 at)",
  "event Delivered(bytes32 indexed caseId, address indexed carrier, uint256 refund)",
  "function breachStart() view returns (uint40)",
  "function paid() view returns (uint256)",
]);

const TESTNET = dep.network === "testnet";
const RPC = import.meta.env.VITE_SENSOR_RPC ?? (TESTNET ? "https://testnet-rpc.monad.xyz" : "http://127.0.0.1:8545");
const pub = createPublicClient({ transport: http(RPC) });
const txUrl = (h: string) => `https://testnet.monadvision.com/tx/${h}`;
const addrUrl = (a: string) => `https://testnet.monadvision.com/address/${a}`;

type Tpl = { caseId: string; goods: string; what: string; trigger: number; limit: number; bondEur: number; graceS: number; rateWei: string; capWei: string };
const tpls = new Map<string, Tpl>((dep.templates as Tpl[]).map((t) => [t.caseId, t]));
const unit = (id: string, v: number) =>
  id.endsWith("/temp") ? `${(v / 10).toFixed(1)} °C` : id.endsWith("/pressure") ? `${(v / 10).toFixed(1)} bar` : `${(v / 10).toFixed(1)} g`;
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const monFmt = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString("de-DE", { maximumFractionDigits: 4 })} MON`;
const eurEq = (wei: bigint) => `≈ €${Math.round(Number(formatEther(wei)) * dep.eurPerMon).toLocaleString("de-DE")}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// status: 0 in limits, 1 excursion (grace), 2 paying
type Copy = { address: Address; caseId: string; index: number; state: number; paid: bigint; last?: number; lastTx?: string; lastBlock?: bigint };
const copies: Copy[] = dep.copies.map((c) => ({ ...(c as { address: Address; caseId: string; index: number }), state: 0, paid: 0n }));
const byAddr = new Map(copies.map((c) => [c.address.toLowerCase(), c]));
type Ev = { name: string; caseId: string; value?: number; block: bigint; tx: string; logIndex: number; amount?: bigint; secs?: number };
const feed: Ev[] = [];
const perBlock = new Map<bigint, number>();
let readings = 0;
let balances = { w1: 0n, w2: 0n, escrow: 0n };
let paidTotal = 0n;
let lastResult = "";

// ---- layout -------------------------------------------------------------------------------------------------
const app = document.getElementById("app")!;
app.innerHTML = `
<header class="s-head">
  <div>
    <h1>Sensor contracts <span class="s-net ${TESTNET ? "live" : "local"}">${TESTNET ? "LIVE · Monad testnet" : "LOCAL CHAIN · not testnet"}</span></h1>
    <p class="s-sub">One contract per wagon condition, funded with the carrier's bond in MON. A reading past the limit starts an excursion; after the grace period every reading pays seconds × rate in MON to the customer, in the same transaction, until the wagon is back in limits (terms from the case data; 1 MON stands for €${dep.eurPerMon.toLocaleString("de-DE")}).</p>
  </div>
  <a class="s-back" href="/">← Dashboard</a>
</header>
<p class="s-prov"><b>SIMULATED</b> sensor values (4 Hz stream, every 10th sample on-chain, breaches at once) · <b class="real">REAL</b> transactions, contract checks and MON payments (testnet MON)</p>
<section class="s-controls">
  <button data-t="">Run all sensors <small>one reading per contract, all at once</small></button>
  <button data-auto="12">Run 12 rounds <small>all sensors, no incident · ≈ 50 s</small></button>
  <button data-t="s1/W02/temp" class="hot">Overheat · frozen food <small>s1 W02 above −15 °C · ~40 s: grace, paid, recovery</small></button>
  <button data-t="s3/W02/temp" class="hot">Overheat · pharma <small>s3 W02 above 8 °C · ~40 s: grace, paid, recovery</small></button>
  <button data-t="s3/W05/pressure" class="hot">Leak · hazmat tank <small>s3 W05 below 3.8 bar, no grace</small></button>
  <p id="result" class="s-result" aria-live="polite"></p>
</section>
<section class="s-stats" id="stats"></section>
<section class="s-row">
  <div class="s-card"><h2>Sensor transactions per block</h2><div id="bars" class="s-bars"></div><p class="s-note">Each contract has its own storage, so these transactions don't conflict and Monad runs them in parallel.</p></div>
  <div class="s-card"><h2>Wallets</h2><dl id="wallets" class="s-dl"></dl></div>
</section>
<section class="s-card"><h2>Contracts</h2><div id="tiles" class="s-tiles"></div></section>
<section class="s-card"><h2>Chain feed</h2><ol id="feed" class="s-feed"></ol></section>`;

const $ = (id: string) => document.getElementById(id)!;

function render() {
  const blocks = [...perBlock.keys()].sort((a, b) => (a < b ? -1 : 1)).slice(-40);
  const max = Math.max(1, ...blocks.map((b) => perBlock.get(b)!));
  $("bars").innerHTML = blocks.length
    ? blocks.map((b) => `<div class="bar" style="height:${(perBlock.get(b)! / max) * 100}%" title="block ${b}: ${perBlock.get(b)} tx"><span>${perBlock.get(b)}</span></div>`).join("")
    : `<p class="s-note">No sensor transactions yet. Press “Run all sensors”.</p>`;
  const trig = copies.filter((c) => c.state > 0).length;
  $("stats").innerHTML = [
    ["On-chain readings seen", String(readings)],
    ["Blocks with readings", String(perBlock.size)],
    ["Most in one block", String(blocks.length ? Math.max(...perBlock.values()) : 0)],
    ["MON paid to wallet 2", monFmt(paidTotal)],
    ["Wagons out of limits", `${trig} / ${copies.length}`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  const link = (a: string) => (TESTNET ? `<a href="${addrUrl(a)}" target="_blank" rel="noreferrer">${short(a)}</a>` : short(a));
  $("wallets").innerHTML = `
    <dt>Wallet 2 · customer ${link(dep.customer)}</dt><dd><b>${monFmt(balances.w2)}</b></dd>
    <dt>paid to it by these contracts</dt><dd>${monFmt(paidTotal)} <span class="s-note">${eurEq(paidTotal)}</span></dd>
    <dt>Wallet 1 · carrier ${link(dep.carrier)}</dt><dd>${monFmt(balances.w1)}</dd>
    <dt>Bonds left in the contracts</dt><dd>${monFmt(balances.escrow)}</dd>`;
  $("tiles").innerHTML = copies.map((c) => {
    const t = tpls.get(c.caseId)!;
    const st = c.state === 2 ? "paying" : c.state === 1 ? "grace" : "in limits";
    const cap = BigInt(t.capWei);
    return `<div class="tile ${c.state === 2 ? "triggered" : c.state === 1 ? "grace" : "active"}">
      <div class="tile-h"><b>${esc(c.caseId)}</b><span class="pill">${st}</span></div>
      <div class="tile-g">${esc(t.goods)} · limit ${esc(t.what)} · grace ${t.graceS} s · ${monFmt(BigInt(t.rateWei))}/s</div>
      <div class="tile-v">${c.last === undefined ? "–" : unit(c.caseId, c.last)}</div>
      <div class="tile-g">paid ${monFmt(c.paid)} of ${monFmt(cap)}</div>
      <div class="tile-f">${c.lastTx ? (TESTNET ? `<a href="${txUrl(c.lastTx)}" target="_blank" rel="noreferrer">block ${c.lastBlock}</a>` : `block ${c.lastBlock}`) : "no reading yet"} · ${link(c.address)}</div>
    </div>`;
  }).join("");
  $("feed").innerHTML = feed.slice(-40).reverse().map((e) => {
    const what = e.name === "Compensation"
      ? `💸 <b>${esc(e.caseId)}</b> paid ${monFmt(e.amount!)} to wallet 2 for ${e.secs} s`
      : e.name === "ExcursionStarted" ? `🔥 <b>${esc(e.caseId)}</b> out of limits at ${unit(e.caseId, e.value!)} · grace period starts`
      : e.name === "ExcursionEnded" ? `✅ <b>${esc(e.caseId)}</b> back in limits at ${unit(e.caseId, e.value!)} · payments stop`
      : e.name === "Delivered" ? `✓ <b>${esc(e.caseId)}</b> delivered · ${monFmt(e.amount!)} back to wallet 1`
      : `${esc(e.caseId)} reading ${unit(e.caseId, e.value!)}`;
    return `<li class="ev-${e.name}"><span class="blk">#${e.block}</span><span>${what}</span>${TESTNET ? `<a href="${txUrl(e.tx)}" target="_blank" rel="noreferrer">${short(e.tx)}</a>` : ""}</li>`;
  }).join("") || `<li class="s-note">Waiting for events…</li>`;
  $("result").innerHTML = lastResult;
}

// ---- chain reads ----------------------------------------------------------------------------------------------
let cursor: bigint | null = null;
const seen = new Set<string>();
async function poll() {
  const latest = await pub.getBlockNumber();
  let from = cursor ?? (latest > 300n ? latest - 300n : 0n);
  while (from <= latest) {
    const to = from + 99n < latest ? from + 99n : latest;
    const logs = await pub.getLogs({ address: copies.map((c) => c.address), fromBlock: from, toBlock: to });
    for (const l of logs) {
      const id = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let ev;
      try { ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { continue; }
      const c = byAddr.get(l.address.toLowerCase());
      if (!c) continue;
      const a = ev.args as { value?: number; amount?: bigint; refund?: bigint; secondsPaid?: number };
      const e: Ev = { name: ev.eventName, caseId: c.caseId, value: a.value, amount: a.amount ?? a.refund, secs: a.secondsPaid, block: l.blockNumber!, tx: l.transactionHash!, logIndex: l.logIndex! };
      feed.push(e);
      if (ev.eventName === "Reading") {
        readings++;
        perBlock.set(e.block, (perBlock.get(e.block) ?? 0) + 1);
        c.last = e.value; c.lastTx = e.tx; c.lastBlock = e.block;
      }
      if (ev.eventName === "ExcursionStarted") c.state = 1;
      if (ev.eventName === "Compensation") { c.state = 2; c.paid += e.amount!; paidTotal += e.amount!; }
      if (ev.eventName === "ExcursionEnded") c.state = 0;
    }
    from = to + 1n;
  }
  cursor = from;
}

// The public RPC allows ~15 requests/s per viewer: read contract state one by one, on load and after each round.
async function refreshStates() {
  for (const c of copies) {
    const start = await pub.readContract({ address: c.address, abi: ABI, functionName: "breachStart" });
    const paid = await pub.readContract({ address: c.address, abi: ABI, functionName: "paid" });
    if (paid > c.paid) { paidTotal += paid - c.paid; c.paid = paid; }
    c.state = start === 0 ? 0 : c.state === 2 ? 2 : 1;
    await new Promise((r) => setTimeout(r, 90));
  }
}
async function refreshBalances() {
  const w2 = await pub.getBalance({ address: dep.customer as Address });
  const w1 = await pub.getBalance({ address: dep.carrier as Address });
  const escrow = copies.reduce((s, c) => s + BigInt(tpls.get(c.caseId)!.capWei) - c.paid, 0n);
  balances = { w1, w2, escrow };
}

async function loop() {
  try { await poll(); render(); } catch (e) { console.warn(e); }
  setTimeout(loop, 1500);
}
async function slowLoop() {
  try { await refreshBalances(); render(); } catch (e) { console.warn(e); }
  setTimeout(slowLoop, 5000);
}

// ---- buttons --------------------------------------------------------------------------------------------------
const HOT_ROUNDS = 5; // ≈ 21 s at one round per 4.2 s: 10 s grace, then ~11 s paid

async function round(trigger?: string, label = ""): Promise<boolean> {
  const res = await fetch("/api/sensors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trigger }) });
  const r = await res.json();
  if (!r.ok) { lastResult = `${label}Not sent: ${esc(r.error ?? "unknown error")}`; return false; }
  const paid = (r.payments as { caseId: string; amountWei: string; seconds: number }[]).map((p) => `💸 ${esc(p.caseId)} ${monFmt(BigInt(p.amountWei))} (${p.seconds} s)`);
  lastResult = `${label}✓ ${r.confirmed}/${r.sent} real transactions in ${r.totalMs} ms · ${r.blocks.length} block(s), up to ${r.maxPerBlock} in one block` +
    (paid.length ? ` · ${paid.join(" · ")}` : "") + (r.failed ? ` · ${r.failed} failed` : "");
  return true;
}
document.querySelectorAll<HTMLButtonElement>(".s-controls button").forEach((b) =>
  b.addEventListener("click", async () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>(".s-controls button");
    buttons.forEach((x) => (x.disabled = true));
    lastResult = "Sending one reading to every contract…";
    render();
    try {
      // a hot button plays the whole excursion: out of limits ~22 s (grace, then paid seconds), then back in limits
      const n = Number(b.dataset.auto ?? (b.dataset.t ? "9" : "1"));
      for (let i = 1; i <= n; i++) {
        const t0 = Date.now();
        // the page, not a chain read, decides how long the wagon stays hot: rounds 1–HOT_ROUNDS out of limits, then back in
        const hot = b.dataset.t && i <= HOT_ROUNDS ? b.dataset.t : undefined;
        const phase = b.dataset.t ? (i <= HOT_ROUNDS ? "🔥 out of limits · " : "❄️ back in limits · ") : "";
        const ok = await round(hot, (n > 1 ? `round ${i}/${n} · ` : "") + phase);
        render();
        refreshStates().then(refreshBalances).then(render).catch(() => {});
        if (!ok) break;
        const wait = 4200 - (Date.now() - t0); // the server allows one round every 4 s
        if (i < n && wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch (e) {
      lastResult = `Not sent: ${esc((e as Error).message)}`;
    }
    buttons.forEach((x) => (x.disabled = false));
    render();
  }),
);

render();
refreshStates().then(refreshBalances).then(render).catch((e) => console.warn(e)).finally(() => { loop(); slowLoop(); });
