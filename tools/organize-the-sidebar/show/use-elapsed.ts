// packages/group/show/use-elapsed.ts
//
// The live wall-clock elapsed-time primitive — ONE source for every "how long has
// this been running" readout on the board. Both the in-flight producer card
// (item-renderers `PendingItem`) and the time-log panel's running timer
// (`TimeLogPanel`) are configurations of THIS hook: real elapsed seconds since an
// epoch-ms start stamp, ticking once a second, NEVER faked progress (L117). One
// primitive, N subscribers (L069) — a new "elapsed since X" readout is a call site,
// not new timing code.

import React from 'react';

/** Live wall-clock seconds since `startedAt` (epoch ms). Returns null when there is
 *  no valid start stamp, so a caller renders nothing rather than a lie. Ticks every
 *  1s while a start is present; stops (clears the interval) when it clears. */
export function useElapsedSeconds(startedAt: unknown): number | null {
  const start = typeof startedAt === 'number' && startedAt > 0 ? startedAt : null;
  const [now, setNow] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (start == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [start]);
  return start == null ? null : Math.max(0, Math.floor((now - start) / 1000));
}

/** Human elapsed: "45s" under a minute, "M:SS" at/over a minute. */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
