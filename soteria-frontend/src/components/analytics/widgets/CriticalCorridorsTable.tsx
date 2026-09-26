import React from 'react';

const CORRIDORS = [
  { id: 'C-FRA-STR', name: 'Frankfurt Hbf → Stuttgart Hbf', activeTrains: 14, avgDelay: '+42m', bottleneck: 'Signal Failure', status: 'critical' },
  { id: 'C-MUC-NUE', name: 'München Hbf → Nürnberg Hbf', activeTrains: 8, avgDelay: '+18m', bottleneck: 'Congestion', status: 'warning' },
  { id: 'C-HAM-BRE', name: 'Hamburg Hbf → Bremen Hbf', activeTrains: 11, avgDelay: '+12m', bottleneck: 'Weather', status: 'warning' },
  { id: 'C-BER-LEI', name: 'Berlin Hbf → Leipzig Hbf', activeTrains: 9, avgDelay: '+2m', bottleneck: 'None', status: 'ok' },
  { id: 'C-KOL-DUS', name: 'Köln Hbf → Düsseldorf Hbf', activeTrains: 22, avgDelay: '+1m', bottleneck: 'None', status: 'ok' },
];

export const CriticalCorridorsTable: React.FC = () => {
  return (
    <div className="analytics-card span-6">
      <div className="card-header-dense">
        <span className="card-title-dense">Critical Corridors (Live)</span>
        <span className="card-subtitle-dense">Top 5 routes by average delay</span>
      </div>
      
      <div className="table-container">
        <table className="dense-table">
          <thead>
            <tr>
              <th>Corridor</th>
              <th>Trains</th>
              <th>Avg Delay</th>
              <th>Bottleneck</th>
            </tr>
          </thead>
          <tbody>
            {CORRIDORS.map((row) => (
              <tr key={row.id}>
                <td className="col-main">{row.name}</td>
                <td>{row.activeTrains}</td>
                <td className={`status-${row.status}`}>{row.avgDelay}</td>
                <td>{row.bottleneck}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
