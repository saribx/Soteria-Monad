import React, { useState } from 'react';
import { useFleet } from '../../context/FleetContext';
import { Train, Truck, AlertTriangle, CheckCircle2, Clock, MapPin, Gauge, Package, Filter } from 'lucide-react';
import './fleet-view.css';

export const FleetView: React.FC = () => {
  const { assets, selectAsset } = useFleet();
  const [filter, setFilter] = useState<string>('all');

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'offline':
        return { color: 'var(--accent-rose)', bg: 'rgba(225, 29, 72, 0.1)', border: 'rgba(225, 29, 72, 0.3)', icon: <AlertTriangle size={14} /> };
      case 'warning':
        return { color: 'var(--accent-amber)', bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.3)', icon: <AlertTriangle size={14} /> };
      default:
        return { color: 'var(--accent-emerald)', bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.3)', icon: <CheckCircle2 size={14} /> };
    }
  };

  // Compute stats
  const total = assets.length;
  const critical = assets.filter(a => a.status === 'offline').length;
  const warnings = assets.filter(a => a.status === 'warning').length;
  const nominal = assets.filter(a => a.status === 'online').length;

  const filteredAssets = assets.filter(a => {
    if (filter === 'all') return true;
    if (filter === 'critical') return a.status === 'offline';
    if (filter === 'warning') return a.status === 'warning';
    if (filter === 'nominal') return a.status === 'online';
    return true;
  });

  return (
    <div className="fleet-view-container">
      <div className="fleet-overview-bar">
        <div className="fleet-filter-group">
          <button className={`fleet-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All <span className="filter-count">{total}</span>
          </button>
          <button className={`fleet-filter-btn ${filter === 'nominal' ? 'active' : ''}`} onClick={() => setFilter('nominal')}>
            Nominal <span className="filter-count">{nominal}</span>
          </button>
          <button className={`fleet-filter-btn ${filter === 'warning' ? 'active' : ''}`} onClick={() => setFilter('warning')}>
            Warnings <span className="filter-count">{warnings}</span>
          </button>
          <button className={`fleet-filter-btn ${filter === 'critical' ? 'active' : ''}`} onClick={() => setFilter('critical')}>
            Critical <span className="filter-count">{critical}</span>
          </button>
        </div>
      </div>

      <div className="fleet-list">
        {filteredAssets.map((asset) => {
          const statusConfig = getStatusConfig(asset.status);
          const isDelayed = asset.delayMin > 10;
          
          return (
            <div 
              key={asset.id} 
              className="fleet-list-item"
              onClick={() => selectAsset(asset)}
              style={{
                '--status-color': statusConfig.color,
                '--status-bg': statusConfig.bg,
                '--status-border': statusConfig.border,
              } as React.CSSProperties}
            >
              {/* Top Row */}
              <div className="fleet-item-top">
                <div className="fleet-col-basics">
                  <div className="fleet-icon-minimal">
                    {asset.type === 'train' ? <Train size={24} /> : <Truck size={24} />}
                  </div>
                  <div className="fleet-basics-text">
                    <h3 className="fleet-name-minimal">{asset.name}</h3>
                    <span className="fleet-category-minimal">{asset.flag} {asset.category}</span>
                  </div>
                </div>

                <div className="fleet-col-location">
                  <span className="stat-lbl">Current Location</span>
                  <span className="stat-val" title={asset.currentStation}>{asset.currentStation}</span>
                </div>

                <div className="fleet-col-right-group">
                  <div className="fleet-col-wagons">
                    <span className="wagon-label-minimal">{asset.compartments.length} Units — {asset.cargoIntegrityPct}% Integrity</span>
                    <div className="minimal-wagons">
                      {asset.compartments.map((comp, idx) => (
                        <div 
                          key={idx} 
                          className={`wagon-segment ${comp.status}`} 
                          title={`${comp.name} - ${comp.status}`} 
                        />
                      ))}
                    </div>
                  </div>

                  <div className="fleet-col-status">
                    <div className="status-badge-minimal" style={{ background: statusConfig.bg, borderColor: statusConfig.border, color: statusConfig.color }}>
                      {statusConfig.icon}
                      {asset.status === 'offline' ? 'CRITICAL' : asset.status === 'warning' ? 'WARNING' : 'NOMINAL'}
                    </div>
                  </div>
                </div>
              </div>

              {/* What is wrong with this train (warning / critical only) */}
              {asset.status !== 'online' && (
                <div className="fleet-item-alert" style={{ color: statusConfig.color, background: statusConfig.bg, borderColor: statusConfig.border }}>
                  {statusConfig.icon}
                  <span>{asset.statusText}</span>
                </div>
              )}

              {/* Bottom Row */}
              <div className="fleet-item-bottom">
                <div className="fleet-col-route">
                  <div className="route-minimal">
                    <div className="route-station">
                      <span className="route-city">{asset.origin || 'Origin'}</span>
                      <span className="route-time-minimal">{asset.departureTime || '00:00'}</span>
                    </div>
                    
                    <div className="route-path-container">
                      <span className="route-delay-indicator" style={{ color: isDelayed ? 'var(--accent-rose)' : 'var(--text-dim)' }}>
                        {asset.delayMin > 0 ? `+${asset.delayMin}m Delay` : 'ON TIME'}
                      </span>
                      <div className="route-path-line">
                        <div className="route-path-progress" style={{ width: `${asset.routeProgressPct}%`, background: statusConfig.color, boxShadow: `0 0 10px ${statusConfig.color}` }}></div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                        <span>{Math.round((asset.routeProgressPct / 100) * asset.routeLengthKm)} km</span>
                        <span>Traveling: {asset.travelTimeMin} min</span>
                        <span>{asset.routeLengthKm} km</span>
                      </div>
                    </div>

                    <div className="route-station right">
                      <span className="route-city">{asset.destination || 'Destination'}</span>
                      <span className="route-time-minimal">{asset.arrivalTime || '00:00'}</span>
                    </div>
                  </div>
                </div>

                <div className="fleet-col-stats">
                  <div className="stat-minimal">
                    <span className="stat-lbl">Speed</span>
                    <span className="stat-val">{asset.speedKmh} km/h</span>
                  </div>
                  <div className="stat-minimal">
                    <span className="stat-lbl">ETA</span>
                    <span className={`stat-val ${isDelayed ? 'delay' : 'ontime'}`}>
                      {asset.status === 'offline' ? 'Unknown' : `${asset.estimatedArrivalMin}m`}
                    </span>
                  </div>
                  <div className="stat-minimal">
                    <span className="stat-lbl">Cargo</span>
                    <span className="stat-val truncate" title={asset.cargoType}>{asset.cargoType}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
