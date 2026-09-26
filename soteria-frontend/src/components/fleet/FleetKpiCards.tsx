import React from 'react';
import { CheckCircle2, OctagonX } from 'lucide-react';
import { useFleet } from '../../context/FleetContext';

export const FleetKpiCards: React.FC = () => {
  const { metrics, filterType, setFilterType } = useFleet();

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
      {/* In operation: running trains, with or without a warning */}
      <div 
        className={`glass-card ${filterType === 'in_operation' ? 'selected' : ''}`}
        onClick={() => setFilterType(filterType === 'in_operation' ? 'all' : 'in_operation')}
        style={{ 
          padding: '10px 14px', 
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          <CheckCircle2 size={15} color="var(--accent-emerald)" />
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
            In Operation
          </span>
        </div>
        <span style={{ fontSize: '28px', fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
          {metrics.inOperationCount}
        </span>
      </div>

      {/* Out of service: trains stopped by a critical incident */}
      <div 
        className={`glass-card ${filterType === 'out_of_service' ? 'selected' : ''}`}
        onClick={() => setFilterType(filterType === 'out_of_service' ? 'all' : 'out_of_service')}
        style={{ 
          padding: '10px 14px', 
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          <OctagonX size={15} color="var(--accent-rose)" />
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
            Out of Service
          </span>
        </div>
        <span style={{ fontSize: '28px', fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
          {metrics.outOfServiceCount}
        </span>
      </div>
    </div>
  );
};
