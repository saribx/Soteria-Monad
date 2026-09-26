import React from 'react';
import './analytics.css';
import { TopKPIBar } from './widgets/TopKPIBar';
import { NetworkPerformanceCurve } from './widgets/NetworkPerformanceCurve';
import { CriticalCorridorsTable } from './widgets/CriticalCorridorsTable';
import { PredictiveMaintenanceQueue } from './widgets/PredictiveMaintenanceQueue';
import { IncidentRootCause } from './widgets/IncidentRootCause';

export const AnalyticsView: React.FC = () => {
  return (
    <div className="analytics-container-dense">
      <div className="analytics-bento-dense">
        {/* Top Row: Core KPIs */}
        <div className="span-12">
          <TopKPIBar />
        </div>

        {/* Middle Row: Network Curve */}
        <NetworkPerformanceCurve />

        {/* Bottom Row: Tables */}
        <CriticalCorridorsTable />
        <PredictiveMaintenanceQueue />

        {/* Footer Row: Root Cause Bar */}
        <IncidentRootCause />
      </div>
    </div>
  );
};
