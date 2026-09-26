import React from 'react';
import { compensation, coverage, monitoringCost } from '../../../chain/analytics';
import { eur } from '../../../chain/cases';

// Top row: what the network is doing right now, from the chain.

export const LiveKpis: React.FC = () => {
  const cov = coverage();
  const comp = compensation();
  const cost = monitoringCost();
  const paid = comp.coldChain + comp.delay + comp.settled;
  const open = comp.accruing + comp.pendingDelay + comp.frozenDelay;

  const kpis = [
    {
      label: 'Wagons monitored',
      val: `${cov.monitored} / ${cov.wagons}`,
      color: '#fff',
      trend: `${cov.readings.toLocaleString('en-US')} readings`,
      trendColor: 'var(--monad)',
      desc: 'Only sensitive cargo carries a sensor; general goods send nothing',
    },
    {
      label: 'Compensation paid',
      val: eur(paid),
      color: 'var(--accent-emerald)',
      trend: `${comp.payoutCount} payouts`,
      trendColor: 'var(--accent-emerald)',
      desc: `${eur(comp.coldChain + comp.delay)} automatic · ${eur(comp.settled)} signed settlements`,
    },
    {
      label: 'Open exposure',
      val: eur(open),
      color: open > 0 ? 'var(--accent-rose)' : '#fff',
      trend: comp.accruing > 0 ? 'accruing now' : '',
      trendColor: 'var(--accent-rose)',
      desc: `${eur(comp.accruing)} accruing · ${eur(comp.pendingDelay)} delay pending · ${eur(comp.frozenDelay)} disputed`,
    },
    {
      label: 'Sensor → payout',
      val: comp.payoutLatencyMs ? `${(comp.payoutLatencyMs / 1000).toFixed(2)} s` : '—',
      color: 'var(--monad)',
      trend: comp.payoutFinalMs ? `final ${(comp.payoutFinalMs / 1000).toFixed(2)} s` : '',
      trendColor: 'var(--accent-emerald)',
      desc: 'Median, reading sent to payout in a block · a paper claim takes weeks',
    },
    {
      label: 'Monitoring cost',
      val: cost.perTx ? `${cost.perTx.toFixed(4)} MON` : '—',
      color: '#fff',
      trend: 'per reading',
      trendColor: 'var(--text-dim)',
      desc: cost.perTx
        ? `≈ ${cost.perWagonDay.toFixed(1)} MON per wagon-day at rest · ${cost.spent.toFixed(3)} of ${cost.cap} MON spent`
        : 'Measured from gas actually paid',
    },
  ];

  return (
    <div className="kpi-bar">
      {kpis.map(k => (
        <div key={k.label} className="kpi-card">
          <div className="kpi-label">{k.label}</div>
          <div className="kpi-val-row">
            <span className="kpi-val" style={{ color: k.color }}>{k.val}</span>
            {k.trend && <span className="kpi-trend" style={{ color: k.trendColor }}>{k.trend}</span>}
          </div>
          <div className="kpi-desc">{k.desc}</div>
        </div>
      ))}
    </div>
  );
};
