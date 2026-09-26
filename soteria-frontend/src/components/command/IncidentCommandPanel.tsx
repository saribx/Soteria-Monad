import React from 'react';
import { ShieldCheck, KeyRound, Lock, Users, Train, MapPin, AlertTriangle, Gauge, Clock, Loader2 } from 'lucide-react';
import { useFleet } from '../../context/FleetContext';
import { SOTERIA_BY_INCIDENT } from '../../data/mockFleetData';
import type { FleetAsset, TrainWagon } from '../../types/fleet';
import { ContractCard } from '../chain/ContractCard';
import { channels, explorerTx, live, useChannel } from '../../chain/store';
import { caseOfAsset } from '../../chain/cases';
import './command-panel.css';

// Bottom of the live map: everything the operator needs about the incident
// they are looking at (selected train, otherwise the newest report).

const CARGO: Record<string, { label: string; color: string }> = {
  hazmat: { label: 'Hazmat', color: '#eab308' },
  pharmaceutical: { label: 'Pharma', color: '#c084fc' },
  perishable: { label: 'Chilled', color: '#38bdf8' },
  general_goods: { label: 'General', color: '#94a3b8' },
};
const cargoOf = (w: TrainWagon) => CARGO[w.cargoClass] ?? { label: w.cargoClass.replace('_', ' '), color: '#71717a' };

const TIER_ACCENT: Record<number, string> = { 1: 'var(--accent-emerald)', 2: 'var(--accent-amber)', 3: 'var(--accent-rose)' };

// During a live run the decision exists once Soteria has anchored it on chain
function useAnchor(assetId: string) {
  useChannel(channels.chain);
  useChannel(channels.state);
  const caseId = caseOfAsset(assetId);
  const st = live.relayer ? live.state : undefined;
  if (!caseId || !st || st.cases[caseId].phase !== 'incident') return { live: false as const };
  const sid = st.cases[caseId].shipmentId;
  const anchor = live.chain.events.find(e => e.name === 'DecisionAnchored' && Number(e.args.shipment) === sid);
  return { live: true as const, anchor };
}

const DecisionCard: React.FC<{ incidentId: string; trainName: string; assetId: string }> = ({ incidentId, trainName, assetId }) => {
  const result = SOTERIA_BY_INCIDENT[incidentId];
  const d = result?.decision;
  const chain = useAnchor(assetId);
  if (chain.live && !chain.anchor) {
    return (
      <div className="glass-card command-card">
        <div className="command-card-head"><span><ShieldCheck size={13} /> Soteria decision</span><span className="command-sub">{trainName} · {incidentId}</span></div>
        <div className="command-empty" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} className="step-spin" /> Assessing: the five roles answer need-to-know questions…
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="glass-card command-card">
        <div className="command-card-head"><span>Soteria decision</span><span className="command-sub">{trainName}</span></div>
        <div className="command-empty">No assessment recorded for this incident yet.</div>
      </div>
    );
  }
  const accent = d.tier ? TIER_ACCENT[d.tier] : 'var(--text-muted)';
  const keysHave = d.grants?.length ?? 0;
  const blocked = result.blockedChannels ?? [];

  return (
    <div className="glass-card command-card">
      <div className="command-card-head">
        <span><ShieldCheck size={13} /> Soteria decision</span>
        <span className="command-sub">{trainName} · {incidentId}</span>
      </div>

      <div className="command-measures">
        {d.status === 'blocked'
          ? <span className="command-chip" style={{ borderColor: 'var(--accent-rose)', color: 'var(--text-rose)' }}>Blocked · {d.reasonLabel ?? d.code}</span>
          : d.measures.map(m => (
            <span key={m.code} className="command-chip" style={{ borderColor: accent, color: '#fff' }}>{m.label}</span>
          ))}
      </div>

      <div className="command-rows">
        <div className="command-row">
          <span>Authority</span>
          <span style={{ color: accent }}>{d.tier ? `Tier ${d.tier}` : '—'}{d.reasonLabel ? ` · ${d.reasonLabel}` : ''}</span>
        </div>
        <div className="command-row">
          <span><KeyRound size={11} /> Human keys</span>
          <span style={{ color: d.keysNeeded && keysHave >= d.keysNeeded ? 'var(--text-emerald)' : 'var(--text-amber)' }}>
            {d.keysNeeded ? `${keysHave} of ${d.keysNeeded} given` : 'not required'}
          </span>
        </div>
        <div className="command-row">
          <span><Users size={11} /> Parties answered</span>
          <span>{d.coverage ? `${d.coverage.answered} / ${d.coverage.asked} fields` : '—'}</span>
        </div>
        <div className="command-row">
          <span><Lock size={11} /> Outbound channels</span>
          <span style={{ color: blocked.length ? 'var(--text-rose)' : 'var(--text-emerald)' }}>
            {blocked.length ? `Quarantined · ${blocked.length} shut` : 'Open'}
          </span>
        </div>
      </div>

      {d.receiptHash && (
        <div className="command-foot">
          Receipt {d.receiptHash}
          {chain.live && chain.anchor && (
            <> · anchored on Monad #{chain.anchor.block.toLocaleString('en-US')}{' '}
              {explorerTx(chain.anchor.tx) && <a href={explorerTx(chain.anchor.tx)} target="_blank" rel="noreferrer" style={{ color: '#836ef9' }}>↗</a>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const ConsistCard: React.FC<{ asset: FleetAsset }> = ({ asset }) => {
  const wagons = asset.wagons ?? [];
  const damaged = wagons.filter(w => w.damaged);
  const classes = [...new Set(wagons.map(w => w.cargoClass))];

  return (
    <div className="glass-card command-card">
      <div className="command-card-head">
        <span><Train size={13} /> Train &amp; damage</span>
        <span className="command-sub">1 loco · {wagons.length} wagons</span>
      </div>

      <div className="consist-strip" aria-label="Train consist, locomotive first">
        <div className="consist-car consist-loco" title="Locomotive" />
        {wagons.map(w => (
          <div
            key={w.id}
            className={`consist-car ${w.damaged ? 'is-damaged' : ''}`}
            style={{ background: cargoOf(w).color }}
            title={`${w.id} · ${cargoOf(w).label}${w.type === 'refrigerated' ? ' · refrigerated' : ''}${w.damage ? ` — ${w.damage}` : ''}`}
          >
            <span>{w.id.replace('W', '')}</span>
          </div>
        ))}
      </div>

      <div className="consist-legend">
        {classes.map(c => (
          <span key={c}><i style={{ background: CARGO[c]?.color ?? '#71717a' }} />{CARGO[c]?.label ?? c}</span>
        ))}
        <span><i className="legend-damaged" />Damaged</span>
      </div>

      <div className={`consist-damage ${damaged.length > 0 ? 'has-damage' : ''}`}>
        {damaged.length === 0 && <div className="command-empty">No wagon damage reported.</div>}
        {damaged.map(w => (
          <div key={w.id} className="consist-damage-row">
            <span className="consist-damage-id" style={{ color: cargoOf(w).color }}>{w.id}</span>
            <span>{w.damage}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const LineCard: React.FC<{ asset: FleetAsset; symptom: string }> = ({ asset, symptom }) => {
  const track = asset.track;
  // Exact position when both ends are real stations on the mapped corridor
  const measured = track && track.origin.isStation && track.destination.isStation;
  const totalKm = measured ? (track.destination.alongM - track.origin.alongM) / 1000 : asset.routeLengthKm;
  const doneKm = measured ? Math.max(0, (track.headAlongM - track.origin.alongM) / 1000) : (asset.routeProgressPct / 100) * asset.routeLengthKm;
  const pct = Math.min(100, Math.max(0, (doneKm / Math.max(totalKm, 0.001)) * 100));
  const closed = track?.trackBlocked ?? false;
  const km = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));

  return (
    <div className="glass-card command-card">
      <div className="command-card-head">
        <span><MapPin size={13} /> Line</span>
        <span className={`command-status ${closed ? 'is-closed' : 'is-open'}`}>{closed ? 'Stopped' : 'Open'}</span>
      </div>

      <div className="line-ends">
        <span>{asset.origin}</span>
        <span>{asset.destination}</span>
      </div>
      <div className="line-bar">
        <div className="line-bar-done" style={{ width: `${pct}%` }} />
        <div className={`line-bar-train ${closed ? 'is-closed' : ''}`} style={{ left: `${pct}%` }} />
      </div>
      <div className="line-km">km {km(doneKm)} of {km(totalKm)}</div>


      <div className="line-stats">
        <div><Gauge size={11} /><span>{asset.speedKmh} km/h</span></div>
        <div><Clock size={11} /><span style={{ color: asset.delayMin > 30 ? 'var(--text-rose)' : asset.delayMin > 0 ? 'var(--text-amber)' : undefined }}>+{asset.delayMin} min</span></div>
        <div><span className="line-next">{asset.nextStation}</span></div>
      </div>
    </div>
  );
};

export const IncidentCommandPanel: React.FC = () => {
  const { activeIncident, assets } = useFleet();
  const asset = assets.find(a => a.id === activeIncident?.assetId);
  if (!activeIncident || !asset) return null;

  return (
    <section className="bottom-metrics-panel command-panel has-contract">
      <DecisionCard incidentId={activeIncident.id} trainName={asset.name.replace('Freight train ', '')} assetId={asset.id} />
      <ConsistCard asset={asset} />
      <LineCard asset={asset} symptom={activeIncident.title} />
      <ContractCard assetId={asset.id} />
    </section>
  );
};
