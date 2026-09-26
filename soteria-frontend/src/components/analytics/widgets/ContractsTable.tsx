import React from 'react';
import { contractRows } from '../../../chain/analytics';
import { eur } from '../../../chain/cases';

// The shipments booked on chain in this run and where each contract stands.

const DELAY_CLASS: Record<string, string> = { 'on time': 'ok', accrued: 'warning', disputed: 'warning', waived: 'ok', paid: 'critical' };

export const ContractsTable: React.FC = () => {
  const rows = contractRows();
  return (
    <div className="analytics-card span-5">
      <div className="card-header-dense">
        <span className="card-title-dense">Contracts on chain</span>
        <span className="card-subtitle-dense">Bond, automatic payouts, signed settlements, delay and decision per shipment</span>
      </div>
      <div className="table-container">
        <table className="dense-table">
          <thead>
            <tr>
              <th>Shipment</th>
              <th>Bond left</th>
              <th>Paid</th>
              <th>Delay</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.sid}>
                <td className="col-main">
                  {r.ref} <span className="dim-note">#{r.sid}</span>
                  <div className="dim-note">{r.customer} · {r.route}</div>
                </td>
                <td>
                  {eur(r.bond - r.auto)}
                  <div className="dim-note">of {eur(r.bond)}</div>
                </td>
                <td className={r.auto + r.settled ? 'status-ok' : ''}>
                  {eur(r.auto + r.settled)}
                  <div className="dim-note">{eur(r.auto)} auto · {eur(r.settled)} signed</div>
                </td>
                <td className={`status-${DELAY_CLASS[r.delay]}`}>
                  {r.delay}
                  {r.terms && <div className="dim-note">{eur(r.terms.contract_penalty)} · {r.terms.contract_deadline_h} h</div>}
                </td>
                <td>
                  {r.tier ? <span className="status-ok">anchored · tier {r.tier}</span> : '—'}
                  {r.terms && <div className="dim-note">cap {eur(r.terms.liability_cap)}</div>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} className="dim-note">No shipment booked. Go live in the Monad panel on the map.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
