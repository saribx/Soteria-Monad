// Builds a self-contained HTML dashboard of the MON sensor contracts from data/tx-history.json (run collect.ts first).
// No external requests: data, CSS and JS are inlined; explorer links are plain links.
//   npx tsx dashboard.ts [out.html]
import { readFileSync, writeFileSync } from "node:fs";
import { ROOT } from "./common.js";

const data = readFileSync(`${ROOT}sensor-demo/data/tx-history.json`, "utf8");
const out = process.argv[2] ?? `${ROOT}sensor-demo/data/tx-dashboard.html`;

const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sensor Transactions</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #7b7a74; --rule: #e4e3de; --grid: #ecebe6;
  --series: #2a78d6; --critical: #d03b3b; --good: #0ca30c; --accent-soft: #e8f0fb; --crit-soft: #fbeaea; --good-soft: #e7f5e7;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8e8d85; --rule: #2e2e2c; --grid: #262624;
    --series: #3987e5; --accent-soft: #1b2a3f; --crit-soft: #3a1d1d; --good-soft: #16301a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 var(--sans); padding-inline: 20px; }
.wrap { max-width: 1240px; margin: 0 auto; padding-block: 28px 64px; display: flex; flex-direction: column; gap: 20px; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
h2 { margin: 0 0 12px; font-size: 16px; }
p { margin: 0; }
a { color: var(--series); }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--ink-2); }
.small { font-size: 12px; color: var(--ink-3); }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 18px; min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.tag { font: 600 11px var(--mono); letter-spacing: .06em; padding: 3px 8px; border-radius: 4px; background: var(--accent-soft); color: var(--series); }

/* money to wallet 2 */
.money { display: grid; grid-template-columns: minmax(240px, 1fr) 2fr; gap: 20px; border: 2px solid var(--good); }
.big { font-size: 44px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.big small { font-size: 18px; font-weight: 600; color: var(--ink-2); }
.check { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; font-weight: 600; color: var(--good); background: var(--good-soft); padding: 3px 8px; border-radius: 4px; }
.pay { width: 100%; border-collapse: collapse; font-size: 13px; }
.pay th { text-align: left; font: 600 11px var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); padding: 6px 8px; border-bottom: 1px solid var(--rule); }
.pay td { padding: 8px; border-bottom: 1px solid var(--rule); vertical-align: top; font-variant-numeric: tabular-nums; }
.pay tr:last-child td { border-bottom: 0; }
.amt { font-weight: 700; white-space: nowrap; }
.flow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.flow .arrow { color: var(--good); font-weight: 700; }
.hint { font-size: 12px; color: var(--ink-2); border-top: 1px dashed var(--rule); padding-top: 10px; margin-top: 10px; }

/* tiles */
.tiles { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.tile span { font-size: 12px; color: var(--ink-2); }
.tile b { font-size: 24px; font-variant-numeric: tabular-nums; }

/* charts */
.charts { display: grid; grid-template-columns: 1fr; gap: 20px; }
svg text { fill: var(--ink-2); font: 11px var(--sans); }
.multiples { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.mult { border: 1px solid var(--rule); border-radius: 8px; padding: 10px 10px 4px; }
.mult h3 { margin: 0; font-size: 13px; }
.mult .sub { font-size: 11px; color: var(--ink-3); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.legend i.line { width: 16px; height: 0; border-radius: 0; border-top: 2px dashed var(--ink-3); vertical-align: 3px; }
#tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; padding: 6px 9px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.12); z-index: 10; max-width: 320px; }

/* history */
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
.filters select, .filters input { font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--rule); background: var(--surface); color: var(--ink); }
.filters input { min-width: 220px; }
.tablewrap { overflow-x: auto; }
table.hist { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 860px; }
.hist th { position: sticky; top: 0; background: var(--surface); text-align: left; font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); padding: 8px; border-bottom: 1px solid var(--rule); }
.hist td { padding: 7px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hist tr.pay-row td { background: var(--crit-soft); }
.hist tr.refund-row td { background: var(--good-soft); }
.pill { font: 600 10.5px var(--mono); padding: 2px 6px; border-radius: 3px; border: 1px solid var(--rule); }
.pill.ok { color: var(--good); border-color: currentColor; }
:focus-visible { outline: 2px solid var(--series); outline-offset: 2px; }
@media (max-width: 900px) {
  .money { grid-template-columns: 1fr; }
  .tiles { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="head">
    <div>
      <h1>Sensor transactions</h1>
      <p class="muted">Every transaction of the sensor-contract demo, read back from <b>Monad testnet</b>. <span id="collected"></span></p>
    </div>
    <span class="tag">REAL · chain 10143</span>
  </header>

  <section class="card money" aria-labelledby="money-h">
    <div>
      <h2 id="money-h">Money to wallet 2 (customer)</h2>
      <p class="mono" id="custAddr"></p>
      <p class="big" id="custTotal"></p>
      <p style="margin-top:8px"><span class="check" id="custCheck"></span></p>
      <p class="hint">Paid in native testnet MON straight from the sensor contracts, so it shows up in any wallet without importing a token.</p>
    </div>
    <div>
      <table class="pay" aria-label="Payments to wallet 2">
        <thead><tr><th>When</th><th>Reading that paid</th><th>Amount</th><th>Transaction</th></tr></thead>
        <tbody id="payRows"></tbody>
      </table>
      <p class="hint" id="refundLine"></p>
    </div>
  </section>

  <section class="tiles" id="tiles" aria-label="Totals"></section>

  <section class="card">
    <h2>Transactions per block</h2>
    <p class="small" style="margin-bottom:8px">Blocks that contain demo transactions, in chain order. Hover a bar for details.</p>
    <div id="bars"></div>
  </section>

  <section class="card">
    <h2>Sensor readings by condition</h2>
    <div class="legend"><span><i style="background:var(--series)"></i>reading sent on-chain</span><span><i style="background:var(--critical)"></i>reading that paid MON to wallet 2</span><span><i class="line"></i>limit</span></div>
    <p class="small" style="margin-bottom:10px">Sensor values are simulated (every 10th sample of a 4 Hz stream); each dot is a real transaction. x = order on chain.</p>
    <div class="multiples" id="mults"></div>
  </section>

  <section class="card">
    <h2>Transaction history</h2>
    <div class="filters">
      <label>Type <select id="fKind"><option value="">all</option></select></label>
      <label>Condition <select id="fCase"><option value="">all</option></select></label>
      <input id="fText" type="search" placeholder="Search hash, address, block…" aria-label="Search">
      <span class="small" id="fCount"></span>
    </div>
    <div class="tablewrap">
      <table class="hist">
        <thead><tr><th>Time (UTC)</th><th>Block</th><th>Type</th><th>Condition</th><th>Reading</th><th>MON paid</th><th>Fee</th><th>Status</th><th>Transaction</th></tr></thead>
        <tbody id="histRows"></tbody>
      </table>
    </div>
  </section>

  <p class="small">Sensor values are simulated; transactions, contract checks and MON payments are real (testnet MON).
  Regenerate: <span class="mono">npx tsx --env-file=.env collect.ts && npx tsx dashboard.ts</span></p>
</div>
<div id="tip" hidden></div>

<script>
const D = __DATA__;
const EXP = "https://testnet.monadvision.com";
const tx = (h) => '<a href="' + EXP + '/tx/' + h + '" target="_blank" rel="noreferrer" class="mono">' + h.slice(0, 10) + '…' + h.slice(-6) + '</a>';
const addr = (a) => '<a href="' + EXP + '/address/' + a + '" target="_blank" rel="noreferrer" class="mono">' + a + '</a>';
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const time = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const date = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const tpl = Object.fromEntries((D.deployment.templates || []).map((t) => [t.caseId, t]));
const unit = (id, v) => v === undefined || v === null ? '' : id.endsWith('/temp') ? (v / 10).toFixed(1) + ' °C' : id.endsWith('/pressure') ? (v / 10).toFixed(1) + ' bar' : (v / 10).toFixed(1) + ' g';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mon = (n) => n.toLocaleString('de-DE', { maximumFractionDigits: 4 }) + ' MON';
const eurEq = (n) => '≈ €' + Math.round(n * D.deployment.eurPerMon).toLocaleString('de-DE');
const addrOf = Object.fromEntries(D.deployment.copies.map((c) => [c.caseId, c.address]));

document.getElementById('collected').textContent = 'Collected ' + D.collectedAt.replace('T', ' ').slice(0, 19) + ' UTC from ' + D.rpc + '.';

// ---- money to wallet 2 ----
const pays = D.txs.filter((t) => t.kind === 'MON payment');
const sumPaid = pays.reduce((s, t) => s + t.paidMon, 0);
document.getElementById('custAddr').innerHTML = addr(D.deployment.customer);
document.getElementById('custTotal').innerHTML = mon(sumPaid).replace(' MON', '') + ' <small>MON received · ' + eurEq(sumPaid) + '</small>';
document.getElementById('custCheck').textContent = '✓ ' + pays.length + ' payments by the contracts · wallet balance now ' + mon(D.balances.customerMon) + ' (block ' + D.balances.atBlock + ')';
document.getElementById('payRows').innerHTML = pays.slice().reverse().map((t) => {
  const tp = tpl[t.caseId] || {};
  return '<tr><td>' + date(t.time) + '<br><span class="small">' + time(t.time) + ' UTC · block ' + t.block + '</span></td>' +
    '<td><b>' + esc(t.caseId) + '</b> ' + esc(tp.goods || '') + '<br><span class="small">read ' + unit(t.caseId, t.value) + ', limit ' + esc(tp.what || '') + ' · ' + t.seconds + ' s × ' + mon(Number(tp.rateWei) / 1e18) + '/s</span>' +
    '<div class="flow small"><span>contract ' + short(addrOf[t.caseId] || '') + '</span><span class="arrow">→</span><span>wallet 2</span></div></td>' +
    '<td class="amt">' + mon(t.paidMon) + '</td><td>' + tx(t.hash) + '</td></tr>';
}).join('') || '<tr><td colspan="4" class="small">No payments yet.</td></tr>';
const refunds = D.txs.filter((t) => t.kind === 'Delivery refund');
document.getElementById('refundLine').innerHTML = 'Scale: 1 MON stands for €' + D.deployment.eurPerMon.toLocaleString('de-DE') + ' (terms from the case data). Wallet 1 (carrier) ' + addr(D.deployment.carrier) +
  (refunds.length ? ' got ' + refunds.map((t) => mon(t.refundMon) + ' back from ' + esc(t.caseId) + ' (' + tx(t.hash) + ')').join('; ') + '.' : ' gets the rest of each bond back on delivery.');

// ---- tiles ----
const readings = D.txs.filter((t) => t.value !== undefined && t.value !== null);
const payouts = pays;
const perBlock = new Map();
for (const t of D.txs) perBlock.set(t.block, (perBlock.get(t.block) || 0) + 1);
const fees = D.txs.reduce((s, t) => s + Number(t.feeMon), 0);
const failed = D.txs.filter((t) => t.status !== 'success').length;
document.getElementById('tiles').innerHTML = [
  ['Transactions', D.txs.length], ['Failed', failed], ['Sensor readings', readings.length],
  ['MON payments', payouts.length], ['Most in one block', Math.max(...perBlock.values())], ['Gas fees', mon(fees)],
].map(([k, v]) => '<div class="tile"><span>' + k + '</span><b>' + v + '</b></div>').join('');

// ---- tooltip ----
const tip = document.getElementById('tip');
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; const x = Math.min(e.clientX + 14, innerWidth - 330); tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { tip.hidden = true; }

// ---- transactions per block (bars) ----
(function () {
  const blocks = [...perBlock.entries()].sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])));
  const W = 1180, H = 200, L = 34, B = 26, T = 10;
  const max = Math.max(...blocks.map((b) => b[1]));
  const bw = (W - L - 10) / blocks.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Transactions per block">';
  for (let g = 0; g <= max; g += Math.max(1, Math.ceil(max / 4))) {
    s += '<line x1="' + L + '" x2="' + (W - 10) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--grid)"/>';
    s += '<text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g + '</text>';
  }
  blocks.forEach(([b, n], i) => {
    const x = L + i * bw + 1, h = (H - T - B) * (n / max);
    const kinds = D.txs.filter((t) => t.block === b).map((t) => t.kind);
    const hasPay = kinds.includes('MON payment');
    const top = y(n), r = Math.min(4, (bw - 2) / 2);
    s += '<path d="M' + x + ',' + (H - B) + ' V' + (top + r) + ' Q' + x + ',' + top + ' ' + (x + r) + ',' + top + ' H' + (x + bw - 2 - r) + ' Q' + (x + bw - 2) + ',' + top + ' ' + (x + bw - 2) + ',' + (top + r) + ' V' + (H - B) + ' Z" fill="' + (hasPay ? 'var(--critical)' : 'var(--series)') + '" data-b="' + b + '" data-n="' + n + '" data-k="' + esc([...new Set(kinds)].join(', ')) + '"/>';
    s += '<rect x="' + (L + i * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="transparent" data-b="' + b + '" data-n="' + n + '" data-k="' + esc([...new Set(kinds)].join(', ')) + '"/>';
  });
  s += '<text x="' + L + '" y="' + (H - 6) + '">block ' + blocks[0][0] + '</text><text x="' + (W - 10) + '" y="' + (H - 6) + '" text-anchor="end">block ' + blocks[blocks.length - 1][0] + '</text>';
  s += '</svg><p class="small">Red bar = block with a MON payment. ' + blocks.length + ' blocks shown.</p>';
  const el = document.getElementById('bars'); el.innerHTML = s;
  el.querySelectorAll('[data-b]').forEach((r) => {
    r.addEventListener('mousemove', (e) => showTip(e, '<b>block ' + r.dataset.b + '</b><br>' + r.dataset.n + ' transaction(s)<br><span class="small">' + r.dataset.k + '</span>'));
    r.addEventListener('mouseleave', hideTip);
  });
})();

// ---- readings small multiples ----
(function () {
  const byCase = new Map();
  readings.forEach((t) => { if (!byCase.has(t.caseId)) byCase.set(t.caseId, []); byCase.get(t.caseId).push(t); });
  const W = 300, H = 140, L = 54, R = 8, T = 16, B = 18;
  let html = '';
  for (const [id, rs] of [...byCase.entries()].sort()) {
    const tp = tpl[id] || { limit: 0, what: '' };
    const vals = rs.map((r) => r.value).concat([tp.limit]);
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(2, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const x = (i) => L + (W - L - R) * (rs.length === 1 ? 0.5 : i / (rs.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(id) + ' readings">';
    [lo + pad, (lo + hi) / 2, hi - pad].forEach((g) => { s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--grid)"/><text x="' + (L - 4) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + unit(id, Math.round(g)) + '</text>'; });
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(tp.limit) + '" y2="' + y(tp.limit) + '" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>';
    s += '<polyline fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" points="' + rs.map((r, i) => x(i) + ',' + y(r.value)).join(' ') + '"/>';
    rs.forEach((r, i) => {
      const pay = r.kind === 'MON payment';
      s += '<circle cx="' + x(i) + '" cy="' + y(r.value) + '" r="' + (pay ? 6 : 4) + '" fill="' + (pay ? 'var(--critical)' : 'var(--series)') + '" stroke="var(--surface)" stroke-width="2" data-h="' + r.hash + '" data-v="' + esc(unit(id, r.value)) + '" data-b="' + r.block + '" data-p="' + (pay ? esc(mon(r.paidMon)) : '') + '"/>';
      if (pay) {
        const right = x(i) > W * 0.6, above = y(r.value) > T + 14;
        s += '<text x="' + (right ? x(i) - 9 : x(i) + 9) + '" y="' + (above ? y(r.value) - 9 : y(r.value) + 16) + '" text-anchor="' + (right ? 'end' : 'start') + '" style="fill:var(--critical);font-weight:600">' + mon(r.paidMon) + '</text>';
      }
    });
    s += '</svg>';
    html += '<div class="mult"><h3>' + esc(id) + '</h3><div class="sub">' + esc(tp.goods || '') + ' · limit ' + esc(tp.what) + ' · ' + rs.length + ' readings</div>' + s + '</div>';
  }
  const el = document.getElementById('mults'); el.innerHTML = html;
  el.querySelectorAll('circle').forEach((c) => {
    c.addEventListener('mousemove', (e) => showTip(e, '<b>' + c.dataset.v + '</b><br>block ' + c.dataset.b + (c.dataset.p ? '<br><b style="color:var(--critical)">payout ' + c.dataset.p + ' → wallet 2</b>' : '') + '<br><span class="mono">' + c.dataset.h.slice(0, 18) + '…</span>'));
    c.addEventListener('mouseleave', hideTip);
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => window.open(EXP + '/tx/' + c.dataset.h, '_blank', 'noreferrer'));
  });
})();

// ---- history table ----
const fKind = document.getElementById('fKind'), fCase = document.getElementById('fCase'), fText = document.getElementById('fText');
[...new Set(D.txs.map((t) => t.kind))].forEach((k) => fKind.insertAdjacentHTML('beforeend', '<option>' + esc(k) + '</option>'));
[...new Set(D.txs.map((t) => t.caseId).filter(Boolean))].sort().forEach((k) => fCase.insertAdjacentHTML('beforeend', '<option>' + esc(k) + '</option>'));
function renderHist() {
  const q = fText.value.trim().toLowerCase();
  const rows = D.txs.filter((t) => (!fKind.value || t.kind === fKind.value) && (!fCase.value || t.caseId === fCase.value) &&
    (!q || [t.hash, t.block, t.caseId, t.kind].join(' ').toLowerCase().includes(q))).slice().reverse();
  document.getElementById('fCount').textContent = rows.length + ' of ' + D.txs.length + ' transactions';
  document.getElementById('histRows').innerHTML = rows.map((t) => {
    const cls = t.kind === 'MON payment' ? 'pay-row' : t.kind === 'Delivery refund' ? 'refund-row' : '';
    const paid = t.paidMon ? mon(t.paidMon) + ' → wallet 2' : t.refundMon ? mon(t.refundMon) + ' → wallet 1' : '';
    return '<tr class="' + cls + '"><td>' + date(t.time) + ' ' + time(t.time) + '</td><td>' + t.block + '</td><td>' + esc(t.kind) + '</td><td>' + esc(t.caseId || '') + '</td>' +
      '<td>' + (t.caseId ? unit(t.caseId, t.value) : '') + '</td><td>' + paid + '</td><td>' + Number(t.feeMon).toFixed(4) + ' MON</td>' +
      '<td><span class="pill ' + (t.status === 'success' ? 'ok' : '') + '">' + esc(t.status) + '</span></td><td>' + tx(t.hash) + '</td></tr>';
  }).join('');
}
[fKind, fCase].forEach((el) => el.addEventListener('change', renderHist));
fText.addEventListener('input', renderHist);
renderHist();
</script>
</body>
</html>`;

writeFileSync(out, html.replace("__DATA__", () => data.trim()));
console.log(`wrote ${out}`);
