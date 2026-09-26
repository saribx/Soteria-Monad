import React from 'react';
import { wagonRows } from '../../../chain/analytics';
import { eur } from '../../../chain/cases';

// Every monitored wagon: its reading now, how long it has been out of range,
// what it has earned the customer and how much of its cap is used.

const fmtDuration = (s: number) => (s < 1 ? '—' : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

export const WagonTable: React.FC = () => {
  const rows = wagonRows();
  return (
    <div className="analytics-card span-7">
      <div className="card-header-dense">
        <span className="card-title-dense">Cold chain & safety per wagon</span>
        <span className="card-subtitle-dense">Monitored wagons of both trains · values live, money from contract events</span>
      </div>
      <div className="table-container">
        <table className="dense-table">
          <thead>
            <tr>
              <th>Wagon</th>
              <th>Now</th>
              <th>Allowed</th>
              <th>Out of range</th>
              <th>Paid / cap</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const tank = r.kind === 'tank';
              const status =
                r.alerts.length ? { text: `alert · ${r.alerts.join(', ')}`, cls: 'critical' }
                : r.open ? { text: r.accruing > 0 ? `accruing ${eur(r.accruing)}` : 'grace period', cls: 'critical' }
                : r.capped ? { text: 'cap reached', cls: 'warning' }
                : r.paid ? { text: 'settled', cls: 'ok' }
                : { text: 'in range', cls: 'ok' };
              const used = r.cap ? Math.min(100, ((r.paid + r.accruing) / r.cap) * 100) : 0;
              return (
                <tr key={r.key}>
                  <td className="col-main">
                    {r.train}/{r.wagon} <span className="dim-note">{r.goods}</span>
                  </td>
                  <td className={status.cls === 'critical' ? 'status-critical' : ''}>
                    {r.value === undefined ? '—' : tank ? `${r.value.toFixed(2)} bar` : `${r.value.toFixed(1)} °C`}
                  </td>
                  <td>{tank ? `≥ ${r.limits.minBar} bar · ≤ ${r.limits.shockMaxG} g` : `${r.limits.minC} … ${r.limits.maxC} °C`}</td>
                  <td>{tank ? '—' : fmtDuration(r.secondsOut)}</td>
                  <td>
                    {tank ? (
                      <span className="dim-note">no automatic payout</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="health-bar-bg">
                          <div className={`health-bar-fill status-bg-${used >= 100 ? 'critical' : used > 0 ? 'warning' : 'ok'}`} style={{ width: `${used}%` }} />
                        </div>
                        <span>{eur(r.paid)} / {eur(r.cap)}</span>
                      </div>
                    )}
                  </td>
                  <td className={`status-${status.cls}`}>{status.text}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={6} className="dim-note">No monitored wagons: the relayer is offline.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
