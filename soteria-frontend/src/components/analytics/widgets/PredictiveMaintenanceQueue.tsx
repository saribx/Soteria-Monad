import React from 'react';

const ASSETS = [
  { id: 'ICE-304', type: 'High Speed', health: 42, component: 'Braking System', ETA: '14h 20m', status: 'critical' },
  { id: 'FR-8812', type: 'Freight', health: 58, component: 'Cooling Unit', ETA: '2d 4h', status: 'warning' },
  { id: 'RE-109', type: 'Regional', health: 64, component: 'Traction Motor', ETA: '4d 12h', status: 'warning' },
  { id: 'ICE-511', type: 'High Speed', health: 91, component: 'None', ETA: '-', status: 'ok' },
  { id: 'IC-202', type: 'Intercity', health: 95, component: 'None', ETA: '-', status: 'ok' },
];

export const PredictiveMaintenanceQueue: React.FC = () => {
  return (
    <div className="analytics-card span-6">
      <div className="card-header-dense">
        <span className="card-title-dense">Predictive Maintenance Queue</span>
        <span className="card-subtitle-dense">Assets nearing failure threshold</span>
      </div>
      
      <div className="table-container">
        <table className="dense-table">
          <thead>
            <tr>
              <th>Asset ID</th>
              <th>Health Score</th>
              <th>Critical Component</th>
              <th>Est. Failure ETA</th>
            </tr>
          </thead>
          <tbody>
            {ASSETS.map((row) => (
              <tr key={row.id}>
                <td className="col-main">{row.id} <span style={{color: 'var(--text-dim)', fontSize:'10px', marginLeft: '4px'}}>{row.type}</span></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="health-bar-bg">
                      <div className={`health-bar-fill status-bg-${row.status}`} style={{ width: `${row.health}%` }} />
                    </div>
                    <span className={`status-${row.status}`}>{row.health}</span>
                  </div>
                </td>
                <td>{row.component}</td>
                <td>{row.ETA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
