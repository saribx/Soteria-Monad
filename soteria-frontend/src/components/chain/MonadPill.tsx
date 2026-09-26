import React from 'react';
import { channels, live, median, perSecond, useChannel } from '../../chain/store';
import { MonadMark } from './MonadPanel';

// Top bar: the chain the dashboard is attached to, its current block and how
// fast our readings land. Replaces the former static latency badge.
export const MonadPill: React.FC = () => {
  useChannel(channels.chain);
  useChannel(channels.state);
  const chain = live.chain;
  const ok = chain.connected || live.relayer;
  const rate = chain.connected ? perSecond(chain.readingTimes) : perSecond(live.receipts);
  const latency = median(live.latencies);
  const network = live.state?.network ?? live.hello?.network;

  return (
    <div
      className={`monad-pill ${ok ? 'ok' : ''}`}
      title={
        ok
          ? `Monad ${network}: block ${chain.block}, ${rate.toFixed(1)} readings/s on chain, median ${latency} ms from sensor to block`
          : 'Not connected to Monad (relayer offline)'
      }
    >
      <MonadMark size={13} />
      {ok ? (
        <>
          <span className="mono">#{chain.block ? chain.block.toLocaleString('en-US') : '—'}</span>
          <span className="monad-pill-sep" />
          <span>{rate.toFixed(1)} tx/s</span>
          {latency > 0 && (
            <>
              <span className="monad-pill-sep" />
              <span>{latency} ms</span>
            </>
          )}
        </>
      ) : (
        <span>offline</span>
      )}
    </div>
  );
};
