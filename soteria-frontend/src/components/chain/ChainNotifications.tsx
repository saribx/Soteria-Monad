import React from 'react';
import { ExternalLink } from 'lucide-react';
import { channels, explorerTx, live, useChannel } from '../../chain/store';
import { shortHash } from '../../chain/cases';
import { describe, timing } from './notificationText';
import { MonadMark, useNow } from './MonadPanel';
import './chain.css';

// Notification sidebar: every payout, alert, delay and anchored decision of
// this run, newest first. They stay after the toast has gone.

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
};

/** How many on-chain notifications the bell counts. */
export function useChainNotificationCount() {
  useChannel(channels.ui);
  return live.notifications.length;
}

export const ChainNotifications: React.FC = () => {
  useChannel(channels.ui);
  useChannel(channels.chain);
  useNow(1000);
  const items = [...live.notifications].reverse();
  if (!items.length) return null;

  return (
    <div className="chain-notes">
      <div className="chain-notes-head">
        <MonadMark size={11} /> Live on Monad · {items.length}
      </div>
      {items.map(t => {
        const d = describe(t);
        const link = explorerTx(t.event.tx);
        return (
          <div key={t.id} className={`chain-note tone-${d.tone}`}>
            <div className="chain-toast-icon">{d.icon}</div>
            <div className="chain-toast-body">
              <div className="chain-note-top">
                <span className="chain-note-title">{d.title}</span>
                <span className="chain-note-ago">{ago(Date.now() - t.at)}</span>
              </div>
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
          </div>
        );
      })}
    </div>
  );
};
