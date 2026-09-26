import React from 'react';
import { activity } from '../../../chain/analytics';
import { live } from '../../../chain/store';

// Readings per second that landed on chain (bars) and the median time from
// sending a reading to its block (line), last five minutes, with the moments
// the contract acted.

const W = 1000;
const H = 220;

const MARKER_COLOR: Record<string, string> = {
  ExcursionStarted: 'var(--accent-amber)',
  SafetyAlert: 'var(--accent-rose)',
  Payout: 'var(--accent-emerald)',
  DelayAccrued: 'var(--accent-amber)',
  DecisionAnchored: '#836ef9',
  Storm: '#a1a1aa',
};

export const ChainActivity: React.FC = () => {
  const { bins, markers, start, end } = activity();
  const maxRate = Math.max(5, ...bins.map(b => b.perSecond));
  const maxLat = Math.max(500, ...bins.map(b => b.latencyMs));
  const bw = W / bins.length;
  const x = (t: number) => ((t - start) / (end - start)) * 100;
  const peak = Math.max(...bins.map(b => b.perSecond));
  // Labels of markers close together go on separate rows
  markers.sort((a, b) => a.at - b.at);
  const lastInRow: number[] = [];
  const rows = markers.map(m => {
    const pos = x(m.at);
    let r = lastInRow.findIndex(p => pos - p > 9);
    if (r < 0) r = lastInRow.length;
    lastInRow[r] = pos;
    return r;
  });
  const latPts = bins
    .map((b, i) => (b.latencyMs ? `${i * bw + bw / 2},${H - (b.latencyMs / maxLat) * (H - 20)}` : null))
    .filter(Boolean)
    .join(' ');

  return (
    <div className="analytics-card span-12">
      <div className="card-header-dense">
        <span className="card-title-dense">Chain activity · last 5 minutes</span>
        <span className="card-subtitle-dense">
          Bars: readings per second landing on Monad ({live.chain.connected ? `counted from ${live.chain.kind}` : 'from receipts'}, peak {peak.toFixed(1)}/s) ·
          line: median time from sensor to block (max {Math.round(maxLat)} ms on the scale)
        </span>
      </div>
      <div className="chart-wrapper activity-wrapper">
        <svg viewBox={`0 0 ${W} ${H}`} className="perf-chart-svg" preserveAspectRatio="none">
          {[0.25, 0.5, 0.75].map(f => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid-line" />)}
          {bins.map((b, i) => {
            const h = (b.perSecond / maxRate) * (H - 20);
            return <rect key={i} x={i * bw + 1} y={H - h} width={bw - 2} height={h} fill="rgba(131,110,249,0.75)" rx="1" />;
          })}
          {latPts && <polyline points={latPts} fill="none" stroke="var(--accent-emerald)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        </svg>
        {markers.map((m, i) => (
          <div key={i} className="activity-marker" style={{ left: `${x(m.at)}%`, color: MARKER_COLOR[m.name] }}>
            <span style={{ top: rows[i] * 16, ...(x(m.at) > 88 ? { left: 'auto', right: 4 } : {}) }}>{m.label}</span>
          </div>
        ))}
        <div className="activity-scale">
          <span>{maxRate.toFixed(0)}/s</span>
          <span>0</span>
        </div>
      </div>
      <div className="x-axis">
        <span>−5 min</span>
        <span>−4 min</span>
        <span>−3 min</span>
        <span>−2 min</span>
        <span>−1 min</span>
        <span>now</span>
      </div>
    </div>
  );
};
