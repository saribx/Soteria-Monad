import React from 'react';
import { compensation } from '../../../chain/analytics';
import { eur } from '../../../chain/cases';

// Where the money went, and what is still open, by the rule that moved it.

export const CompensationBreakdown: React.FC = () => {
  const c = compensation();
  const parts = [
    { label: 'Cold chain · automatic', value: c.coldChain, color: 'var(--accent-emerald)' },
    { label: 'Delay · automatic', value: c.delay, color: '#34d399' },
    { label: 'Signed settlements', value: c.settled, color: '#836ef9' },
    { label: 'Accruing now', value: c.accruing, color: 'var(--accent-rose)' },
    { label: 'Delay pending', value: c.pendingDelay, color: 'var(--accent-amber)' },
    { label: 'Delay disputed (frozen)', value: c.frozenDelay, color: '#a16207' },
  ];
  const total = parts.reduce((n, p) => n + p.value, 0);

  return (
    <div className="analytics-card span-12">
      <div className="card-header-dense">
        <span className="card-title-dense">Compensation by rule · {eur(total)} in this run</span>
        <span className="card-subtitle-dense">
          Physical facts pay automatically, judgement needs both signatures: the split shows which rule moved the money
        </span>
      </div>
      <div className="root-cause-bar">
        {total > 0 ? (
          parts.filter(p => p.value > 0).map(p => (
            <div key={p.label} className="root-cause-segment" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${eur(p.value)}`} />
          ))
        ) : (
          <div className="root-cause-segment" style={{ width: '100%', background: 'rgba(255,255,255,0.05)' }} />
        )}
      </div>
      <div className="root-cause-legend">
        {parts.map(p => (
          <div key={p.label} className="legend-item-dense">
            <div className="legend-dot" style={{ background: p.color }} />
            <div className="legend-text">
              <span className="legend-label">{p.label}</span>
              <span className="legend-val">{eur(p.value)}{total ? ` · ${Math.round((p.value / total) * 100)}%` : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
