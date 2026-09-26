import React, { useState } from 'react';
import { Radio, Thermometer, Gauge, Activity, TrainFront, ExternalLink } from 'lucide-react';
import type { FleetAsset } from '../../types/fleet';
import { accruedEur, channels, explorerTx, live, useChannel, type Series } from '../../chain/store';
import { caseOfAsset, devicesOf, eur, shortHash } from '../../chain/cases';
import type { DeviceMeta } from '../../chain/types';
import { SensorChart, MONAD_PURPLE } from './SensorChart';
import './chain.css';

// Live sensors of one train in the fleet tab: the device stream at 4 Hz, the
// contract's allowed range, and a purple pulse whenever a reading lands on
// Monad. Wagons without sensitive goods carry no sensor and say so.

const GOODS_LABEL: Record<string, string> = {
  general_goods: 'General goods',
  perishable: 'Frozen food',
  pharmaceutical: 'Pharmaceuticals',
  hazmat: 'Hazardous liquid',
};

const fmt = (v: number | undefined, digits = 1) => (v === undefined ? '—' : v.toFixed(digits));

function lastOf(s: Series | undefined, key: 'temp' | 'pressure' | 'shock' | 'speed') {
  return s && s[key].length ? s[key][s[key].length - 1] : undefined;
}

function status(d: DeviceMeta, s: Series | undefined) {
  const { open, accrued } = accruedEur(d.key);
  if (open) return { label: accrued > 0 ? `Excursion · ${eur(accrued)}` : 'Excursion · grace', tone: 'rose' as const };
  const alerts = live.chain.events.filter(e => e.name === 'SafetyAlert' && Number(e.args.wagon) === d.wagonId);
  if (alerts.length) return { label: alerts.some(a => a.args.code === 2) ? 'Alert · pressure' : 'Alert · shock', tone: 'rose' as const };
  if (!d.bound) return { label: 'Not booked', tone: 'dim' as const };
  if (s?.escalated) return { label: '1 Hz on chain', tone: 'amber' as const };
  return { label: `every ${live.hello?.demo.heartbeat_s ?? 10} s`, tone: 'ok' as const };
}

const DeviceTile: React.FC<{ d: DeviceMeta; selected: boolean; onSelect: () => void }> = ({ d, selected, onSelect }) => {
  const s = live.series.get(d.key);
  const marks = live.onchain.get(d.key) ?? [];
  const lastMark = marks[marks.length - 1];
  const justLanded = lastMark && Date.now() - lastMark.t < 700;
  const st = status(d, s);
  const isLoco = d.kind === 'loco';
  const isTank = d.kind === 'tank';
  const value = isLoco ? lastOf(s, 'speed') : isTank ? lastOf(s, 'pressure') : lastOf(s, 'temp');

  return (
    <button className={`sensor-tile tone-${st.tone} ${selected ? 'is-selected' : ''}`} onClick={e => { e.stopPropagation(); onSelect(); }}>
      <div className="sensor-tile-head">
        <span className="sensor-tile-id">
          {isLoco ? <TrainFront size={11} /> : isTank ? <Gauge size={11} /> : <Thermometer size={11} />}
          {d.wagon}
        </span>
        <span className={`sensor-chain-dot ${justLanded ? 'landed' : ''}`} title="A reading landed on Monad" />
      </div>
      <div className="sensor-tile-goods">{isLoco ? 'Locomotive' : d.goods}</div>
      <div className="sensor-tile-value">
        {isLoco ? `${fmt(value, 0)} km/h` : isTank ? `${fmt(value, 2)} bar` : `${fmt(value)} °C`}
      </div>
      <div className="sensor-tile-sub">
        <Activity size={10} /> {fmt(lastOf(s, 'shock'), 2)} g
        {!isLoco && d.limits.minC !== undefined && <span> · {d.limits.minC}…{d.limits.maxC} °C</span>}
        {isTank && <span> · min {d.limits.minBar} bar</span>}
      </div>
      {s && (
        <SensorChart
          t={s.t}
          v={isLoco ? s.speed : isTank ? s.pressure : s.temp}
          windowS={45}
          height={34}
          fitBand={false}
          band={!isLoco && !isTank && d.limits.minC !== undefined ? [d.limits.minC, d.limits.maxC!] : undefined}
          floor={isTank ? d.limits.minBar : undefined}
          marks={marks.map(m => m.t)}
          minSpan={isLoco ? 10 : isTank ? 0.3 : 2}
          color={isLoco ? '#a1a1aa' : '#38bdf8'}
        />
      )}
      <div className={`sensor-tile-status tone-${st.tone}`}>{st.label}</div>
    </button>
  );
};

const NoSensorTile: React.FC<{ id: string; cargo: string }> = ({ id, cargo }) => (
  <div className="sensor-tile no-sensor">
    <div className="sensor-tile-head">
      <span className="sensor-tile-id">{id}</span>
    </div>
    <div className="sensor-tile-goods">{GOODS_LABEL[cargo] ?? cargo}</div>
    <div className="sensor-tile-none">No sensor</div>
    <div className="sensor-tile-sub">nothing on chain</div>
  </div>
);

const DeviceDetail: React.FC<{ d: DeviceMeta }> = ({ d }) => {
  const s = live.series.get(d.key);
  const marks = live.onchain.get(d.key) ?? [];
  const isLoco = d.kind === 'loco';
  const isTank = d.kind === 'tank';
  if (!s) return null;
  return (
    <div className="sensor-detail" onClick={e => e.stopPropagation()}>
      <div className="sensor-detail-charts">
        <div>
          <div className="sensor-detail-label">
            {isLoco ? 'Speed (km/h)' : isTank ? 'Tank pressure (bar)' : 'Air temperature (°C)'} · 2 min · device stream 4 Hz ·{' '}
            <span style={{ color: MONAD_PURPLE }}>● on chain</span>
          </div>
          <SensorChart
            t={s.t}
            v={isLoco ? s.speed : isTank ? s.pressure : s.temp}
            windowS={120}
            height={110}
            band={!isLoco && !isTank && d.limits.minC !== undefined ? [d.limits.minC, d.limits.maxC!] : undefined}
            floor={isTank ? d.limits.minBar : undefined}
            marks={marks.map(m => m.t)}
            minSpan={isLoco ? 10 : isTank ? 0.3 : 2}
            color={isLoco ? '#a1a1aa' : '#38bdf8'}
          />
        </div>
        <div>
          <div className="sensor-detail-label">Peak shock (g)</div>
          <SensorChart t={s.t} v={s.shock} windowS={120} height={110} floor={isTank ? d.limits.shockMaxG : undefined} minSpan={0.5} color="#a1a1aa" />
        </div>
      </div>
      <div className="sensor-detail-feed">
        <div className="sensor-detail-label">Last readings on Monad</div>
        {marks.slice(-6).reverse().map(m => (
          <a key={m.hash} className="sensor-detail-tx" href={explorerTx(m.hash)} target="_blank" rel="noreferrer">
            <span>#{m.block.toLocaleString('en-US')}</span>
            <span>{shortHash(m.hash)}</span>
            <span>{m.latencyMs} ms</span>
            {explorerTx(m.hash) && <ExternalLink size={10} />}
          </a>
        ))}
        {!marks.length && <div className="command-empty">No reading on chain yet.</div>}
        <div className="sensor-detail-foot">
          Device {shortHash(d.address)} · wagon #{d.wagonId ?? '—'} · {d.sent} readings sent
        </div>
      </div>
    </div>
  );
};

export const WagonSensors: React.FC<{ asset: FleetAsset }> = ({ asset }) => {
  useChannel(channels.samples);
  useChannel(channels.state);
  const [selected, setSelected] = useState<string | null>(null);
  const caseId = caseOfAsset(asset.id);
  if (!caseId || !asset.wagons) return null;
  const devices = devicesOf(caseId);
  const connected = live.relayer && devices.length > 0;

  return (
    <div className="wagon-sensors" onClick={e => e.stopPropagation()}>
      <div className="wagon-sensors-head">
        <span><Radio size={12} /> Live sensors</span>
        <span className="wagon-sensors-note">
          {connected
            ? `${devices.filter(d => d.kind !== 'loco').length} of ${asset.wagons.length} wagons monitored · device stream 4 Hz · readings on Monad`
            : 'Sensor stream offline: start the relayer (npm start in relayer/)'}
        </span>
      </div>
      {connected && (
        <>
          <div className="wagon-sensors-grid">
            {devices.filter(d => d.kind === 'loco').map(d => (
              <DeviceTile key={d.key} d={d} selected={selected === d.key} onSelect={() => setSelected(selected === d.key ? null : d.key)} />
            ))}
            {asset.wagons.map(w => {
              const d = devices.find(x => x.wagon === w.id);
              return d ? (
                <DeviceTile key={d.key} d={d} selected={selected === d.key} onSelect={() => setSelected(selected === d.key ? null : d.key)} />
              ) : (
                <NoSensorTile key={w.id} id={w.id} cargo={w.cargoClass} />
              );
            })}
          </div>
          {selected && devices.find(d => d.key === selected) && <DeviceDetail d={devices.find(d => d.key === selected)!} />}
        </>
      )}
    </div>
  );
};
