import React, { useState } from 'react';
import { Check, ExternalLink, Loader2, Pause, Play, X } from 'lucide-react';
import { explorerTx, live, median, perSecond } from '../../chain/store';
import { shortHash } from '../../chain/cases';
import type { TxInfo } from '../../chain/types';
import { MonadMark, useNow } from './MonadPanel';
import './chain.css';

// Every transaction the demo sends, as it happens: who signed it, what it did,
// which block took it, what the contract emitted, how fast it landed and when
// consensus finalised it. Each hash opens on the block explorer.

type Filter = 'all' | 'readings' | 'contract' | 'money';

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ms % 1000).padStart(3, '0');

const ROLE: Record<string, string> = {
  book: 'carrier',
  anchor: 'carrier',
  dispute: 'carrier',
  propose: 'carrier',
  accept: 'customer',
  close: 'customer',
  customer: 'customer',
  flag: 'customer · keeper',
  settle: 'customer · keeper',
  gap: 'customer · keeper',
};

function signer(tx: TxInfo) {
  if (tx.device) return `sensor ${tx.device}`;
  return ROLE[tx.label.split(' ')[0]] ?? 'relayer';
}

function Status({ tx }: { tx: TxInfo }) {
  if (tx.ok === false) return <span className="tx-status bad"><X size={10} /> {tx.error ? 'failed' : 'reverted'}</span>;
  if (tx.finalizedAt) return <span className="tx-status final"><Check size={10} /> Finalized</span>;
  if (tx.latencyMs !== undefined) return <span className="tx-status inblock"><Check size={10} /> In block</span>;
  return <span className="tx-status sent"><Loader2 size={10} className="step-spin" /> Sent</span>;
}

export const TransactionsView: React.FC = () => {
  useNow(400); // re-render at 2.5 Hz: readable even at 100 tx/s
  const [filter, setFilter] = useState<Filter>('all');
  const [paused, setPaused] = useState<TxInfo[] | null>(null);

  const eventsByTx = new Map<string, string[]>();
  for (const e of live.chain.events) {
    const list = eventsByTx.get(e.tx) ?? [];
    list.push(e.name);
    eventsByTx.set(e.tx, list);
  }

  const all = paused ?? [...live.txs.values()].reverse();

  const counts = {
    all: all.length,
    readings: all.filter(tx => tx.label.startsWith('report')).length,
    contract: all.filter(tx => !tx.label.startsWith('report')).length,
    money: all.filter(tx => (eventsByTx.get(tx.hash) ?? []).includes('Payout')).length,
  };

  const shown = all
    .filter(tx => {
      const reading = tx.label.startsWith('report');
      if (filter === 'readings') return reading;
      if (filter === 'contract') return !reading;
      if (filter === 'money') return (eventsByTx.get(tx.hash) ?? []).includes('Payout');
      return true;
    })
    .slice(0, 250);

  const st = live.state;
  const hello = live.hello;
  const chain = live.chain;
  const total = live.txs.size;
  const failed = [...live.txs.values()].filter(t => t.ok === false).length;
  const finalized = [...live.txs.values()].filter(t => t.finalizedAt).length;
  const rate = chain.connected ? perSecond(chain.readingTimes) : perSecond(live.receipts);
  const explorer = hello?.explorer;

  return (
    <div className="fleet-view-container tx-view">
      <div className="tx-header">

        <div className="tx-facts">
          <div><span>Contract</span>{explorer && hello ? <a href={`${explorer}/address/${hello.rail}`} target="_blank" rel="noreferrer">{shortHash(hello.rail)} <ExternalLink size={10} /></a> : <b>{shortHash(hello?.rail)}</b>}</div>
          <div><span>Block</span><b>#{chain.block ? chain.block.toLocaleString('en-US') : '—'}</b></div>
          <div><span>Transactions</span><b>{total.toLocaleString('en-US')}</b></div>
          <div><span>Readings / s</span><b>{rate.toFixed(1)}</b></div>
          <div><span>Sensor → block</span><b>{median(live.latencies) || '—'} ms</b></div>
          <div><span>Finalized</span><b>{finalized.toLocaleString('en-US')}</b></div>
          <div><span>Failed</span><b className={failed ? 'bad' : ''}>{failed}</b></div>
          <div><span>Gas spent</span><b>{st ? `${st.budget.spentMon.toFixed(3)} MON` : '—'}</b></div>
        </div>
      </div>

      <div className="tx-toolbar">
        <div className="fleet-filter-group">
          {(
            [
              ['all', 'All'],
              ['readings', 'Sensor readings'],
              ['contract', 'Contract actions'],
              ['money', 'Payouts'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`fleet-filter-btn ${filter === id ? 'active' : ''}`}
              onClick={() => setFilter(id)}
            >
              {label} <span className="filter-count">{counts[id]}</span>
            </button>
          ))}
        </div>
        <button className="monad-btn tx-pause" onClick={() => setPaused(paused ? null : [...live.txs.values()].reverse())}>
          {paused ? <><Play size={12} /> Resume live</> : <><Pause size={12} /> Pause to inspect</>}
        </button>
      </div>

      <div className="tx-table">
        <div className="tx-row tx-head">
          <span>Sent</span><span>Status</span><span>Hash</span><span>Block</span><span>Signed by</span><span>Action</span><span>Contract events</span><span>In block</span><span>Final</span><span>Gas</span>
        </div>
        {!shown.length && <div className="tx-empty">No transactions yet. Go live in the Monad panel on the map.</div>}
        {shown.map(tx => {
          const link = explorerTx(tx.hash);
          const events = eventsByTx.get(tx.hash) ?? (tx.label.startsWith('report') && tx.ok ? ['Reading'] : []);
          return (
            <div key={tx.hash} className={`tx-row ${tx.ok === false ? 'is-bad' : ''} ${events.includes('Payout') ? 'is-money' : ''}`}>
              <span className="mono">{time(tx.sentAt)}</span>
              <Status tx={tx} />
              {link ? <a className="mono" href={link} target="_blank" rel="noreferrer">{shortHash(tx.hash)} <ExternalLink size={9} /></a> : <span className="mono">{shortHash(tx.hash)}</span>}
              <span className="mono">{tx.block ? `#${tx.block.toLocaleString('en-US')}` : '—'}</span>
              <span className="tx-signer" title={tx.from}>{signer(tx)}</span>
              <span className="tx-action">{tx.label.replace(/^report /, 'reading ')}</span>
              <span className="tx-events">{events.map((n, i) => <i key={i} className={`tx-ev ev-${n}`}>{n}</i>)}</span>
              <span className="mono">{tx.latencyMs !== undefined ? `${tx.latencyMs} ms` : '—'}</span>
              <span className="mono">{tx.finalizedAt ? `${((tx.finalizedAt - tx.sentAt) / 1000).toFixed(2)} s` : '—'}</span>
              <span className="mono dim">{tx.gas ? tx.gas.toLocaleString('en-US') : '—'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
