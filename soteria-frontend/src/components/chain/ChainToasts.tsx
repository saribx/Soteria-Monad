import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { channels, dismissToast, explorerTx, live, useChannel } from '../../chain/store';
import { shortHash } from '../../chain/cases';
import { describe, timing } from './notificationText';
import './chain.css';

// What just happened on chain, as it happens: payouts, safety alerts, delays
// and anchored Soteria decisions, each with its block, timing and explorer link.

const LIFETIME_MS = 9_000;
const PAYOUT_LIFETIME_MS = 13_000;

export const ChainToasts: React.FC = () => {
  useChannel(channels.ui);
  useChannel(channels.chain);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      for (const t of live.toasts) if (now - t.at > (t.kind === 'payout' ? PAYOUT_LIFETIME_MS : LIFETIME_MS)) dismissToast(t.id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return createPortal(
    <div className="chain-toasts">
      {live.toasts.slice(-4).map(t => {
        const d = describe(t);
        const link = explorerTx(t.event.tx);
        return (
          <div key={t.id} className={`chain-toast tone-${d.tone}`}>
            <div className="chain-toast-icon">{d.icon}</div>
            <div className="chain-toast-body">
              <div className="chain-toast-title">{d.title}</div>
              <div className="chain-toast-sub">{d.sub}</div>
              <div className="chain-toast-meta">
                {timing(t)}
                {link ? (
                  <a href={link} target="_blank" rel="noreferrer"> · {shortHash(t.event.tx)} <ExternalLink size={9} /></a>
                ) : (
                  <span> · {shortHash(t.event.tx)}</span>
                )}
              </div>
            </div>
            <button className="chain-toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X size={12} /></button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
};
