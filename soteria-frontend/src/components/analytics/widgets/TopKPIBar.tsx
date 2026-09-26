import React from 'react';

const KPIS = [
  { label: 'System Punctuality', val: '92.4%', color: 'var(--accent-emerald)', trend: '+1.2%', trendColor: 'var(--accent-emerald)', desc: '30-day avg: 91.2%' },
  { label: 'Active Delays Impact', val: '€142k', color: 'var(--accent-rose)', trend: '+€12k', trendColor: 'var(--accent-rose)', desc: 'Estimated penalty risk' },
  { label: 'Cargo In-Transit', val: '84.2 kt', color: '#fff', trend: 'High Value: 42%', trendColor: '#fff', desc: 'Cold-Chain: 18% | Bulk: 40%' },
  { label: 'Network Congestion', val: '78', color: 'var(--accent-amber)', trend: '-4', trendColor: 'var(--accent-emerald)', desc: 'Index (0-100), Target < 80' },
  { label: 'Carbon Offset (vs Road)', val: '1.4 kt', color: 'var(--accent-emerald)', trend: 'Today', trendColor: '#fff', desc: 'Cumulative: 24.8 kt' },
];

export const TopKPIBar: React.FC = () => {
  return (
    <div className="kpi-bar">
      {KPIS.map((kpi, i) => (
        <div key={i} className="kpi-card">
          <div className="kpi-label">{kpi.label}</div>
          <div className="kpi-val-row">
            <span className="kpi-val" style={{ color: kpi.color }}>{kpi.val}</span>
            <span className="kpi-trend" style={{ color: kpi.trendColor }}>{kpi.trend}</span>
          </div>
          <div className="kpi-desc">{kpi.desc}</div>
        </div>
      ))}
    </div>
  );
};
