import React from 'react';
import { FileSignature, Landmark, Clock, PenLine, ShieldCheck, ExternalLink } from 'lucide-react';
import { accruedEur, channels, explorerTx, live, useChannel } from '../../chain/store';
import { caseOfAsset, devicesOf, eur, shortHash } from '../../chain/cases';
import { MonadMark } from './MonadPanel';
import './chain.css';

// Bottom panel: the shipment's contract on Monad. Bond, what has been paid,
// what is accruing this second, the delay clock and the signatures.

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const ContractCard: React.FC<{ assetId: string }> = ({ assetId }) => {
  useChannel(channels.chain);
  useChannel(channels.state);
  useChannel(channels.samples); // live values and the accruing counter at 4 Hz
  const caseId = caseOfAsset(assetId);
  const st = live.state;
  const spec = caseId ? live.hello?.demo.cases[caseId] : undefined;

  const head = (sub: React.ReactNode) => (
    <div className="command-card-head">
      <span><FileSignature size={13} /> Contract</span>
      <span className="command-sub">{sub}</span>
    </div>
  );

  if (!caseId || !st || !spec) {
    return <div className="glass-card command-card">{head('offline')}<div className="command-empty">Relayer offline: no contract data.</div></div>;
  }
  const sid = st.cases[caseId].shipmentId;
  if (!sid || !st.live) {
    return <div className="glass-card command-card">{head(spec.shipment_ref)}<div className="command-empty">Not booked on chain yet. Go live in the Monad panel.</div></div>;
  }

  const events = live.chain.events;
  const mine = events.filter(e => Number(e.args.shipment) === sid);
  const booked = mine.find(e => e.name === 'Booked');
  const payouts = mine.filter(e => e.name === 'Payout');
  const automatic = payouts.filter(e => Number(e.args.reason) !== 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
  const settled = payouts.filter(e => Number(e.args.reason) === 3).reduce((n, e) => n + Number(e.args.amountEur), 0);
  const bondLeft = booked ? Number(booked.args.bondEur) - automatic : undefined;

  const reefers = devicesOf(caseId).filter(d => d.kind === 'reefer');
  const accruing = reefers.reduce((n, d) => n + accruedEur(d.key).accrued, 0);

  // delay
  const delayEvents = mine.filter(e => e.name.startsWith('Delay'));
  const lastDelay = delayEvents[delayEvents.length - 1];
  let delay: React.ReactNode = <span className="ok">none</span>;
  if (lastDelay?.name === 'DelayAccrued') {
    const left = Number(lastDelay.args.challengeUntil) * 1000 - Date.now();
    delay = <span className="warn">{eur(Number(lastDelay.args.penaltyEur))} accrued · dispute {fmtClock(left)}</span>;
  } else if (lastDelay?.name === 'DelayDisputed') {
    delay = <span className="warn">disputed · force majeure · frozen</span>;
  } else if (lastDelay?.name === 'DelayResolved') {
    delay = Number(lastDelay.args.state) === 4 ? <span className="ok">waived by both parties</span> : <span className="bad">paid</span>;
  }

  // settlement
  const proposal = mine.find(e => e.name === 'SettlementProposed');
  const signatures = proposal ? events.filter(e => e.name === 'SettlementSigned' && e.args.settlement === proposal.args.settlement).length : 0;

  const anchor = mine.find(e => e.name === 'DecisionAnchored');
  const link = (tx?: string) => (tx && explorerTx(tx) ? <a href={explorerTx(tx)} target="_blank" rel="noreferrer"><ExternalLink size={9} /></a> : null);

  return (
    <div className="glass-card command-card contract-card">
      {head(<><MonadMark size={10} /> {spec.shipment_ref} · #{sid}</>)}

      <div className="contract-accrual">
        <strong>{eur(automatic + settled)}</strong>
        <span>paid to the customer on chain</span>
      </div>

      <div className="command-rows">
        <div className="command-row"><span><Landmark size={11} /> Bond left</span><span>{bondLeft !== undefined ? eur(bondLeft) : '—'}</span></div>
        <div className="command-row"><span><Clock size={11} /> Delay</span>{delay}</div>
        <div className="command-row">
          <span><PenLine size={11} /> Settlement</span>
          <span>{proposal ? <>{eur(Number(proposal.args.amountEur))} · {signatures}/2 signed {link(proposal.tx)}</> : '—'}</span>
        </div>
        <div className="command-row">
          <span><ShieldCheck size={11} /> Decision</span>
          <span>{anchor ? <span className="ok">anchored · tier {anchor.args.tier} {link(anchor.tx)}</span> : '—'}</span>
        </div>
      </div>

      <div className="contract-wagons">
        {devicesOf(caseId).filter(d => d.kind !== 'loco').map(d => {
          const s = live.series.get(d.key);
          const v = d.kind === 'tank' ? s?.pressure.at(-1) : s?.temp.at(-1);
          const out = v !== undefined && (d.kind === 'tank' ? v < (d.limits.minBar ?? 0) : v < (d.limits.minC ?? -99) || v > (d.limits.maxC ?? 99));
          return (
            <span key={d.key} className={`contract-wagon ${out ? 'out' : ''}`} title={`${d.wagon} · ${d.goods} · device ${shortHash(d.address)}`}>
              {d.wagon} <b>{v === undefined ? '—' : d.kind === 'tank' ? `${v.toFixed(2)} bar` : `${v.toFixed(1)} °C`}</b>
            </span>
          );
        })}
      </div>
    </div>
  );
};
