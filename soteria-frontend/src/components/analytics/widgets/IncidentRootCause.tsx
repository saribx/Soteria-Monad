import React, { useEffect, useState } from 'react';

const CAUSES = [
  { label: 'Weather / Storms', delayMin: 2420, percent: 45, color: 'var(--accent-indigo, #6366f1)' },
  { label: 'Signal Failures', delayMin: 1140, percent: 21, color: 'var(--accent-amber)' },
  { label: 'Track Works', delayMin: 850, percent: 16, color: 'var(--accent-rose)' },
  { label: 'Rolling Stock', delayMin: 520, percent: 10, color: 'var(--accent-emerald)' },
  { label: 'Other', delayMin: 440, percent: 8, color: 'var(--text-dim)' },
];

export const IncidentRootCause: React.FC = () => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="analytics-card span-12">
      <div className="card-header-dense">
        <span className="card-title-dense">Incident Root Cause Matrix (Total Network Delay: 5,370m)</span>
      </div>
      
      <div className="root-cause-bar">
        {CAUSES.map(cause => (
          <div 
            key={cause.label}
            className="root-cause-segment"
            style={{ 
              width: mounted ? `${cause.percent}%` : '0%',
              background: cause.color 
            }}
            title={`${cause.label}: ${cause.delayMin}m`}
          />
        ))}
      </div>

      <div className="root-cause-legend">
        {CAUSES.map(cause => (
          <div key={cause.label} className="legend-item-dense">
            <div className="legend-dot" style={{ background: cause.color }} />
            <div className="legend-text">
              <span className="legend-label">{cause.label}</span>
              <span className="legend-val">{cause.percent}% ({cause.delayMin}m)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
