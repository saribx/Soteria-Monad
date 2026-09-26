import React, { useEffect, useState } from 'react';
import { Check, Circle, ExternalLink, Loader2, Minus, Play, RotateCcw, X, Zap, CloudLightning, Snowflake, TreePine } from 'lucide-react';
import { channels, control, explorerTx, live, median, perSecond, setUi, useChannel } from '../../chain/store';
import { devicesOf, eur, shortHash } from '../../chain/cases';
import type { RunState, Step } from '../../chain/types';
import { MONAD_PURPLE } from './SensorChart';
import './chain.css';

export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export const MonadMark: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="5.5" y="5.5" width="13" height="13" rx="3.5" transform="rotate(45 12 12)" fill={MONAD_PURPLE} />
  </svg>
);

const StepIcon: React.FC<{ s: Step['status'] }> = ({ s }) =>
  s === 'done' ? <Check size={12} className="step-ok" />
  : s === 'active' ? <Loader2 size={12} className="step-spin" />
  : s === 'failed' ? <X size={12} className="step-fail" />
  : s === 'skipped' ? <Minus size={12} className="step-skip" />
  : <Circle size={10} className="step-wait" />;

const Timeline: React.FC<{ title: string; run: RunState }> = ({ title, run }) => {
  if (!run.steps.length) return null;
  return (
    <div className="monad-timeline">
      <div className="monad-section-title">{title}{run.running ? ' · running' : ''}</div>
      {run.steps.map(s => (
        <div key={s.id} className={`monad-step is-${s.status}`}>
          <StepIcon s={s.status} />
          <div className="monad-step-body">
            <div className="monad-step-label">{s.label}</div>
            {(s.detail || s.tx) && (
              <div className="monad-step-detail">
                {s.atMs !== undefined && <span>+{(s.atMs / 1000).toFixed(1)} s</span>}
                {s.detail && <span>{s.detail}</span>}
                {s.tx && (
                  explorerTx(s.tx)
                    ? <a href={explorerTx(s.tx)} target="_blank" rel="noreferrer">{shortHash(s.tx)} <ExternalLink size={9} /></a>
                    : <span className="mono">{shortHash(s.tx)}</span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

const Throughput: React.FC<{ times: number[] }> = ({ times }) => {
  const now = Date.now();
  const bins = new Array(60).fill(0);
  for (let i = times.length - 1; i >= 0; i--) {
    const age = Math.floor((now - times[i]) / 1000);
    if (age >= 60) break;
    bins[59 - age]++;
  }
  const max = Math.max(10, ...bins);
  return (
    <div className="monad-bars" title="Readings per second on chain, last 60 s">
      {bins.map((b, i) => (
        <div key={i} style={{ height: `${(b / max) * 100}%` }} />
      ))}
    </div>
  );
};

const StormGrid: React.FC = () => {
  const storm = devicesOf('storm');
  const now = Date.now();
  return (
    <div className="storm-grid">
      {storm.map(d => {
        const marks = live.onchain.get(d.key);
        const last = marks?.[marks.length - 1];
        const hot = last && now - last.t < 350;
        return <div key={d.key} className={`storm-cell ${hot ? 'hot' : ''} ${d.active ? 'on' : ''}`} title={d.key} />;
      })}
    </div>
  );
};

export const MonadPanel: React.FC = () => {
  useChannel(channels.chain);
  useChannel(channels.state);
  useChannel(channels.ui);
  useNow(250);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'd' && !(e.target instanceof HTMLInputElement)) setUi({ controls: !live.ui.controls });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const st = live.state;
  const hello = live.hello;
  if (!live.relayer || !st || !hello) {
    return (
      <aside className="monad-panel glass-panel">
        <div className="monad-head"><MonadMark /> <span>Monad</span></div>
        <div className="command-empty">
          Relayer not reachable. Start it with <code>npm start</code> in <code>relayer/</code>; the dashboard connects on its own.
        </div>
      </aside>
    );
  }

  const chain = live.chain;
  const onChainRate = chain.connected ? perSecond(chain.readingTimes) : perSecond(live.receipts);
  // this run's shipments only
  const current = new Set([st.cases.s1.shipmentId, st.cases.s3.shipmentId, st.storm.shipmentId].filter(Boolean));
  const payouts = chain.events.filter(e => e.name === 'Payout' && current.has(Number(e.args.shipment)));
  const automatic = payouts.filter(e => Number(e.args.reason) !== 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
  const settled = payouts.filter(e => Number(e.args.reason) === 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
  const blockTime = chain.blockTimeMs;
  const latency = median(live.latencies);
  const finality = median(live.finality);
  const netLabel = st.network === 'mainnet' ? 'Mainnet' : st.network === 'testnet' ? 'Testnet' : 'local chain';
  const canRun = st.live && !st.busy;

  return (
    <aside className="monad-panel glass-panel">
      <div className="monad-head">
        <MonadMark />
        <span>Monad {netLabel}</span>
        <span className={`monad-conn ${chain.connected ? 'ok' : ''}`} title={chain.connected ? `Direct WebSocket to the node (${chain.kind})` : 'No direct chain feed'}>
          {chain.connected ? chain.kind : 'no chain feed'}
        </span>
      </div>

      <div className="monad-kpis">
        <div><span>Block</span><strong>#{chain.block ? chain.block.toLocaleString('en-US') : '—'}</strong><em>{blockTime ? `${(blockTime / 1000).toFixed(2)} s blocks` : ''}</em></div>
        <div><span>Readings / s</span><strong>{onChainRate.toFixed(1)}</strong><em>measured on chain</em></div>
        <div><span>Sensor → block</span><strong>{latency ? `${latency} ms` : '—'}</strong><em>median, send to receipt</em></div>
        <div><span>Final after</span><strong>{finality ? `${(finality / 1000).toFixed(2)} s` : '—'}</strong><em>Ethereum: ~13 min</em></div>
        <div><span>Readings on chain</span><strong>{(chain.connected ? chain.readings : live.receipts.length).toLocaleString('en-US')}</strong><em>this session</em></div>
        <div><span>Paid out</span><strong>{eur(automatic + settled)}</strong><em>{eur(automatic)} automatic</em></div>
      </div>

      <Throughput times={chain.connected ? chain.readingTimes : live.receipts} />

      <div className="monad-budget">
        <span>Gas {st.budget.spentMon.toFixed(3)} / {st.budget.capMon.toLocaleString('en-US')} MON</span>
        <span>{st.budget.txs.toLocaleString('en-US')} tx · {st.budget.reverted} reverted</span>
      </div>
      {st.budget.exhausted && <div className="monad-warn">MON spending cap reached: the relayer stopped sending.</div>}

      {(st.storm.running || st.storm.steps.length > 0) && <StormGrid />}

      {live.ui.controls && (
        <div className="monad-controls">
          {!st.live ? (
            <button className="monad-btn primary" disabled={!!st.busy} onClick={() => control('live')}>
              <Play size={12} /> Go live: book both shipments on chain
            </button>
          ) : (
            <>
              <button className="monad-btn" disabled={!canRun || st.cases.s1.phase !== 'normal'} onClick={() => control('s1')}>
                <Snowflake size={12} /> s1 · Reefer failure
              </button>
              <button className="monad-btn" disabled={!canRun || st.cases.s3.phase !== 'normal'} onClick={() => control('s3')}>
                <TreePine size={12} /> s3 · Storm tree
              </button>
              <button className="monad-btn" disabled={!canRun || st.storm.running} onClick={() => control('storm')}>
                <CloudLightning size={12} /> Storm burst · {hello.demo.storm.wagons} wagons
              </button>
              <button className="monad-btn ghost" disabled={!!st.busy} onClick={() => control('reset')}>
                <RotateCcw size={12} /> Reset
              </button>
            </>
          )}
          {st.busy && <div className="monad-busy"><Loader2 size={12} className="step-spin" /> {st.busy}</div>}
          <div className="monad-hint"><Zap size={10} /> {st.sendMode} · press D to hide controls</div>
        </div>
      )}

      {/* the latest run on top */}
      {[
        { title: 's1 · Donner Pass · reefer failure', run: st.cases.s1 as RunState },
        { title: 's3 · Berlin Hbf · storm-felled tree', run: st.cases.s3 as RunState },
        { title: 'Storm burst · Berlin–Hamburg corridor', run: st.storm },
      ]
        .sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
        .map(x => <Timeline key={x.title} title={x.title} run={x.run} />)}
    </aside>
  );
};
