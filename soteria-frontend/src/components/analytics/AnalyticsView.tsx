import React from 'react';
import './analytics.css';
import '../chain/chain.css';
import { useNow } from '../chain/MonadPanel';
import { LiveKpis } from './widgets/LiveKpis';
import { ChainActivity } from './widgets/ChainActivity';
import { WagonTable } from './widgets/WagonTable';
import { ContractsTable } from './widgets/ContractsTable';
import { CompensationBreakdown } from './widgets/CompensationBreakdown';

// Analytics of the current run, computed live from the chain and the device
// stream (see src/chain/analytics.ts). Nothing here is hard-coded.
export const AnalyticsView: React.FC = () => {
  useNow(1000);
  return (
    <div className="analytics-container-dense">
      <div className="analytics-bento-dense">
        <div className="span-12">
          <LiveKpis />
        </div>
        <ChainActivity />
        <WagonTable />
        <ContractsTable />
        <CompensationBreakdown />
      </div>
    </div>
  );
};
