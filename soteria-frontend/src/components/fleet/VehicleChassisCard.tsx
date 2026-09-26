import React from 'react';
import { TrainFront, Radio, Wifi } from 'lucide-react';
import { useFleet } from '../../context/FleetContext';
import { FleetAsset } from '../../types/fleet';

interface VehicleChassisCardProps {
  asset: FleetAsset;
}

export const VehicleChassisCard: React.FC<VehicleChassisCardProps> = ({ asset }) => {
  const { selectedAsset, focusOnAsset, setHoveredAsset } = useFleet();
  const isSelected = selectedAsset?.id === asset.id;
  const isWarning = asset.status === 'warning';
  const isOffline = asset.status === 'offline';

  const trainId = asset.name.split(' ').pop();
  const shortTime = asset.updatedAt.split(', ')[1] ?? asset.updatedAt;
  const hasCargoTemp = asset.targetTempC !== undefined && asset.currentTempC !== undefined;

  return (
    <div
      className={`glass-card ${isSelected ? 'selected' : ''}`}
      onClick={() => focusOnAsset(asset)}
      onMouseEnter={() => setHoveredAsset(asset)}
      onMouseLeave={() => setHoveredAsset(null)}
      style={{
        padding: '10px 12px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '7px'
      }}
    >
      {/* Header: train ID (origin → destination) + last update + expand affordance */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
          <TrainFront size={13} color="var(--text-muted)" style={{ flexShrink: 0 }} />
          <h4
            style={{
              fontSize: '14px',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '-0.01em',
              fontFamily: 'var(--font-mono)'
            }}
          >
            {trainId}
          </h4>
          <span
            title={`${asset.origin} → ${asset.destination}`}
            style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            ({asset.origin} → {asset.destination})
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span
              className={`status-indicator ${isOffline ? 'rose' : isWarning ? 'amber' : 'emerald'}`}
              style={{ width: '6px', height: '6px' }}
            />
            <span
              style={{
                fontSize: '10px',
                fontWeight: 600,
                color: isOffline ? 'var(--accent-rose)' : isWarning ? 'var(--text-amber)' : 'var(--text-emerald)'
              }}
            >
              {isOffline ? 'Critical' : isWarning ? 'Warning' : 'Nominal'}
            </span>
          </span>
          <span style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{shortTime}</span>
        </div>
      </div>

      {/* Status narrative: what's actually happening with this asset */}
      <div
        style={{
          fontSize: '10px',
          lineHeight: 1.35,
          color: isOffline ? 'var(--text-rose)' : isWarning ? 'var(--text-amber)' : 'var(--text-secondary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
        title={asset.statusText}
      >
        {asset.statusText}
      </div>

      {/* Footer: real connectivity state + ETA + cargo temp and current location */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text-muted)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <Radio size={10} color={asset.connectivity.gps ? 'var(--text-secondary)' : 'var(--text-rose)'} />
            GPS
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <Wifi size={10} color={asset.connectivity.lte ? 'var(--accent-emerald)' : 'var(--text-rose)'} />
            1 ms
          </span>
          <span>{asset.connectivity.iotSensors} sensors</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.03em' }}>ETA</span>
            <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
              {isOffline ? '—' : `${asset.estimatedArrivalMin}m`}
            </span>
          </span>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          {hasCargoTemp && <span style={{ fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{asset.currentTempC}°C</span>}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={asset.routeName}>
            {asset.routeName}
          </span>
        </span>
      </div>
    </div>
  );
};
