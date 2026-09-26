import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, Zap, Terminal } from 'lucide-react';
import { useFleet } from '../../context/FleetContext';
import { SOTERIA_BY_INCIDENT } from '../../data/mockFleetData';
import './incidents-view.css';

export const IncidentsView: React.FC = () => {
  const { incidents, activeIncident } = useFleet();
  const [filter, setFilter] = useState<string>('all');

  const total = incidents.length;
  const critical = incidents.filter(i => i.severity === 'high' || i.severity === 'critical').length;
  const warnings = incidents.filter(i => i.severity === 'medium').length;

  const filteredIncidents = incidents.filter(i => {
    if (filter === 'all') return true;
    if (filter === 'critical') return i.severity === 'high' || i.severity === 'critical';
    if (filter === 'warning') return i.severity === 'medium';
    return true;
  });

  const getSeverityConfig = (severity: string) => {
    if (severity === 'high' || severity === 'critical') {
      return { color: 'var(--accent-rose)', bg: 'rgba(225, 29, 72, 0.1)', border: 'rgba(225, 29, 72, 0.3)', icon: <ShieldAlert size={20} /> };
    }
    if (severity === 'medium') {
      return { color: 'var(--accent-amber)', bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.3)', icon: <AlertTriangle size={20} /> };
    }
    return { color: 'var(--accent-emerald)', bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.3)', icon: <Zap size={20} /> };
  };

  return (
    <div className="incidents-view-container">
      
      {/* Overview Bar (matches Fleet View) */}
      <div className="incidents-overview-bar">
        <div className="incidents-filter-group">
          <button className={`incidents-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All <span className="incidents-filter-count">{total}</span>
          </button>
          <button className={`incidents-filter-btn ${filter === 'critical' ? 'active' : ''}`} onClick={() => setFilter('critical')}>
            Critical <span className="incidents-filter-count">{critical}</span>
          </button>
          <button className={`incidents-filter-btn ${filter === 'warning' ? 'active' : ''}`} onClick={() => setFilter('warning')}>
            Warnings <span className="incidents-filter-count">{warnings}</span>
          </button>
        </div>

        {/* Agent Console Pill */}
        <button 
          className="agent-console-pill"
          onClick={() => window.open(`/console.html?incident=${activeIncident?.id ?? ''}`, 'soteria-agent-live-console', 'width=1440,height=900')}
        >
          <div className="agent-dot" />
          Agent Live Console
        </button>
      </div>

      {/* Incidents List */}
      <div className="incidents-list">
        {filteredIncidents.map((incident) => {
          const config = getSeverityConfig(incident.severity);
          const decision = SOTERIA_BY_INCIDENT[incident.id]?.decision;

          return (
            <div 
              key={incident.id} 
              className="incident-list-item"
              style={{
                '--status-color': config.color,
                '--status-bg': config.bg,
                '--status-border': config.border,
              } as React.CSSProperties}
            >
              {/* Top Row: Basic Info */}
              <div className="incident-item-top">
                <div className="incident-col-basics">
                  <div className="incident-icon-minimal">
                    {config.icon}
                  </div>
                  <div className="incident-basics-text">
                    <h3 className="incident-name-minimal">{incident.assetName}</h3>
                    <span className="incident-category-minimal">{incident.category} • {incident.timeAgo}</span>
                  </div>
                </div>

                <div className="incident-col-details">
                  <span className="incident-title">{incident.title}</span>
                  <span className="incident-location">{incident.affectedLocations.join(', ')} • {incident.affectedCount} Units Affected</span>
                </div>

                <div className="incident-col-status">
                  <div className="status-badge-minimal" style={{ background: config.bg, borderColor: config.border, color: config.color }}>
                    TIER {incident.soteriaTier} {incident.severity === 'medium' ? 'WARNING' : 'CRITICAL'}
                  </div>
                </div>
              </div>

              {/* Bottom Row: AI Decision / Action Plan */}
              {decision ? (
                <div className="incident-item-bottom">
                  <div className="decision-col-action">
                    <span className="decision-label">Recommended Action</span>
                    <ol className="decision-measures">
                      {decision.measures.map(m => (
                        <li key={m.code}>{m.label}</li>
                      ))}
                    </ol>
                  </div>

                  <div className="decision-col-rationale">
                    <span className="decision-label">Soteria Rationale</span>
                    <div className="decision-rationale-text">
                      {decision.rationale || "Automated policy response applied based on standard operating procedures."}
                    </div>
                  </div>

                  <div className="decision-col-meta">
                    <div className="decision-meta-row">
                      <span className="decision-meta-lbl">Authority</span>
                      <span className="decision-meta-val" style={{ color: config.color }}>{decision.tierLabel}</span>
                    </div>
                    <div className="decision-meta-row">
                      <span className="decision-meta-lbl">Decided By</span>
                      <span className="decision-meta-val" style={{ color: decision.decidedBy === 'llm' ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                        {decision.decidedBy === 'llm' ? `${decision.model}` : 'Rule Policy'}
                      </span>
                    </div>
                    <div className="decision-meta-row">
                      <span className="decision-meta-lbl">Approval</span>
                      <span className="decision-meta-val">
                        {decision.keysNeeded ? `${decision.grants?.length ?? 0}/${decision.keysNeeded} required` : 'Auto'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="incident-item-bottom">
                  <div className="decision-col-action">
                    <span className="decision-label">Pending Action</span>
                    <div className="decision-measures" style={{ listStyle: 'none', padding: 0 }}>
                      {incident.recommendation}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
