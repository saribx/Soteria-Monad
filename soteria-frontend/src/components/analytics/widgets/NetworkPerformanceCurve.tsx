import React from 'react';

export const NetworkPerformanceCurve: React.FC = () => {
  return (
    <div className="analytics-card span-12 row-span-2">
      <div className="card-header-dense">
        <span className="card-title-dense">24h Network Performance Curve</span>
        <span className="card-subtitle-dense">Planned vs Actual Arrival Times (Aggregated)</span>
      </div>
      
      <div className="chart-wrapper">
        <svg viewBox="0 0 1000 240" className="perf-chart-svg" preserveAspectRatio="none">
          <defs>
            <linearGradient id="actual-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-amber)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--accent-amber)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="planned-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.4)" stopOpacity="0.1" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.4)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Grid Lines */}
          <line x1="0" y1="40" x2="1000" y2="40" className="grid-line" />
          <line x1="0" y1="120" x2="1000" y2="120" className="grid-line" />
          <line x1="0" y1="200" x2="1000" y2="200" className="grid-line" />

          {/* Planned Curve (Smooth, predictable) */}
          <path 
            d="M 0,200 C 100,180 200,80 300,100 C 400,120 500,60 600,120 C 700,180 800,90 900,110 L 1000,180" 
            className="planned-path" 
          />
          <path 
            d="M 0,200 C 100,180 200,80 300,100 C 400,120 500,60 600,120 C 700,180 800,90 900,110 L 1000,180 L 1000,240 L 0,240 Z" 
            fill="url(#planned-grad)" 
          />

          {/* Actual Curve (Spiky, delayed) */}
          <path 
            d="M 0,200 C 100,190 200,40 300,60 C 400,80 500,10 600,80 C 700,190 800,40 900,80 L 1000,190" 
            className="actual-path" 
          />
          <path 
            d="M 0,200 C 100,190 200,40 300,60 C 400,80 500,10 600,80 C 700,190 800,40 900,80 L 1000,190 L 1000,240 L 0,240 Z" 
            fill="url(#actual-grad)" 
          />

          {/* Major Incident Marker */}
          <g transform="translate(500, 10)">
            <line x1="0" y1="0" x2="0" y2="230" stroke="var(--accent-rose)" strokeWidth="1" strokeDasharray="4 4" />
            <circle cx="0" cy="0" r="4" fill="var(--accent-rose)" />
            <text x="10" y="4" fill="var(--accent-rose)" fontSize="11" fontWeight="600">Signal Failure (Frankfurt Hbf)</text>
          </g>
        </svg>

        {/* X Axis Labels */}
        <div className="x-axis">
          <span>00:00</span>
          <span>04:00</span>
          <span>08:00</span>
          <span>12:00</span>
          <span>16:00</span>
          <span>20:00</span>
          <span>24:00</span>
        </div>
      </div>
    </div>
  );
};
