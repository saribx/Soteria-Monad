import React from 'react';
import { FleetKpiCards } from '../fleet/FleetKpiCards';
import { EfficiencySparkline } from '../fleet/EfficiencySparkline';
import { VehicleChassisCard } from '../fleet/VehicleChassisCard';
import { useFleet } from '../../context/FleetContext';

export const LeftDashboardPanel: React.FC = () => {
  const { assets, filterType } = useFleet();

  // Filter assets based on active counter pill or offline filter
  const displayedAssets = assets.filter((asset) => {
    if (filterType === 'train') return asset.type === 'train';
    if (filterType === 'truck') return asset.type === 'truck';
    if (filterType === 'in_operation') return asset.status !== 'offline';
    if (filterType === 'out_of_service') return asset.status === 'offline';
    return true;
  });

  // Pick up to 4 assets to display, stacked at full panel width
  const gridAssets = displayedAssets.slice(0, 4);

  return (
    <aside className="left-dashboard-panel">
      {/* 1. KPI Cards ("Online 5", "Offline 1") */}
      <FleetKpiCards />

      {/* 3. Operational Efficiency Sparkline (78.3%) */}
      <EfficiencySparkline />

      {/* 4. Technical Vehicle Chassis Cards, one per row */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {gridAssets.map((asset) => (
          <VehicleChassisCard key={asset.id} asset={asset} />
        ))}
      </div>
    </aside>
  );
};
