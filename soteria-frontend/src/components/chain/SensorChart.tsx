import React, { useLayoutEffect, useRef } from 'react';

// A small canvas chart for one sensor channel: the live 4 Hz stream as a line,
// the contract's allowed range as a band and every reading that landed on
// chain as a purple dot.

export const MONAD_PURPLE = '#836ef9';

interface Props {
  t: number[];
  v: number[];
  windowS: number;
  height: number;
  band?: [number, number]; // allowed range; outside is out of contract
  floor?: number; // one-sided limit (tank pressure)
  marks?: number[]; // times of on-chain readings
  color?: string;
  minSpan?: number; // smallest y range, so a flat line does not look like noise
  fitBand?: boolean; // false: scale to the data and let the band lines fall where they may
}

export const SensorChart: React.FC<Props> = ({ t, v, windowS, height, band, floor, marks, color = '#38bdf8', minSpan = 1, fitBand = true }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!t.length) return;

    const now = t[t.length - 1];
    const from = now - windowS * 1000;
    let i0 = t.findIndex(x => x >= from);
    if (i0 < 0) i0 = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < v.length; i++) {
      lo = Math.min(lo, v[i]);
      hi = Math.max(hi, v[i]);
    }
    if (band && fitBand) {
      lo = Math.min(lo, band[0]);
      hi = Math.max(hi, band[1]);
    }
    if (floor !== undefined && fitBand) lo = Math.min(lo, floor);
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    const x = (time: number) => ((time - from) / (windowS * 1000)) * width;
    const y = (val: number) => height - ((val - lo) / (hi - lo)) * height;

    // allowed range
    if (band) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(0, y(band[1]), width, y(band[0]) - y(band[1]));
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const b of band) {
        ctx.beginPath();
        ctx.moveTo(0, y(b));
        ctx.lineTo(width, y(b));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (floor !== undefined) {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y(floor));
      ctx.lineTo(width, y(floor));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // live stream
    const last = v[v.length - 1];
    const out = (band && (last < band[0] || last > band[1])) || (floor !== undefined && last < floor);
    ctx.strokeStyle = out ? '#ef4444' : color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i < v.length; i++) {
      const px = x(t[i]);
      const py = y(v[i]);
      if (i === i0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // readings on chain
    if (marks?.length) {
      ctx.fillStyle = MONAD_PURPLE;
      let j = i0;
      for (const m of marks) {
        if (m < from) continue;
        while (j < t.length - 1 && t[j] < m) j++;
        ctx.beginPath();
        ctx.arc(x(m), y(v[j]), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
};
