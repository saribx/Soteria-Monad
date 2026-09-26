import React from 'react';
import { AlertTriangle, BadgeEuro, Clock, ShieldCheck } from 'lucide-react';
import { deviceByWagon, live, type Toast } from '../../chain/store';
import { caseOfShipment, customerOf, eur } from '../../chain/cases';

// Wording of an on-chain notification, shared by the toasts and the sidebar.

export function timing(t: Toast) {
  const tx = live.txs.get(t.event.tx);
  const parts = [`block #${t.event.block.toLocaleString('en-US')}`];
  if (tx?.latencyMs !== undefined) parts.push(`in block after ${(tx.latencyMs / 1000).toFixed(2)} s`);
  const finalAt = tx?.finalizedAt ?? t.event.finalizedAt;
  if (tx && finalAt) parts.push(`final after ${((finalAt - tx.sentAt) / 1000).toFixed(2)} s`);
  return parts.join(' · ');
}

export function describe(t: Toast): { icon: React.ReactNode; title: string; sub: string; tone: string } {
  const e = t.event;
  const a = e.args;
  const wagon = deviceByWagon(a.wagon);
  if (e.name === 'Payout') {
    const who = customerOf(caseOfShipment(a.shipment));
    const reason = Number(a.reason);
    const sub =
      reason === 1 ? `${wagon?.wagon ?? 'Wagon'} · ${wagon?.goods ?? 'cold chain'} out of range · paid automatically`
      : reason === 2 ? 'Delivery slot lost · paid after the challenge window'
      : 'Settlement signed by carrier and customer · paid from the liability pool';
    return { icon: <BadgeEuro size={18} />, title: `${eur(Number(a.amountEur))} paid to ${who}`, sub, tone: 'payout' };
  }
  if (e.name === 'SafetyAlert') {
    const what = Number(a.code) === 1 ? `impact ${(Number(a.value) / 100).toFixed(2)} g` : `tank pressure ${(Number(a.value) / 100).toFixed(2)} bar`;
    return {
      icon: <AlertTriangle size={18} />,
      title: `Safety alert · ${wagon?.wagon ?? 'wagon'} ${wagon?.goods ?? ''}`,
      sub: `${what} · timestamped on chain as proof of notification · no automatic payout`,
      tone: 'alert',
    };
  }
  if (e.name === 'DelayAccrued') {
    return {
      icon: <Clock size={18} />,
      title: `${eur(Number(a.penaltyEur))} delay penalty accrues`,
      sub: `Delivery slot lost · the carrier may dispute until ${new Date(Number(a.challengeUntil) * 1000).toLocaleTimeString('en-GB')}`,
      tone: 'delay',
    };
  }
  if (e.name === 'DelayDisputed') {
    return { icon: <Clock size={18} />, title: 'Carrier disputes the delay', sub: 'Force majeure is a legal question: penalty frozen until both parties sign', tone: 'delay' };
  }
  return {
    icon: <ShieldCheck size={18} />,
    title: `Soteria decision anchored · ${a.incident}`,
    sub: `Tier ${a.tier} · ${a.keys ? `${a.keys} human keys` : 'autonomous'} · receipt head ${String(a.receiptHead).slice(-16)}`,
    tone: 'anchor',
  };
}
