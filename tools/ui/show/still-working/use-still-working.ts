// parts/ui/show/still-working/use-still-working.ts
//
// The React side of still-working.ts: while `running`, the words a long wait says now, read again every second and
// whenever a road asks again; null while the wait's own words stand. Starting again (running false, then true) counts
// from zero. See still-working.ts for the invariants.

import { useEffect, useState } from 'react';
import { onAskedAgain, stillWorkingAt } from './still-working';

export function useStillWorking(running: boolean, label: string): string | null {
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const at = Date.now();
    setStarted(at);
    setNow(at);
    setTries(0);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const stop = onAskedAgain(() => { setTries(count => count + 1); setNow(Date.now()); });
    return () => { window.clearInterval(tick); stop(); };
  }, [running]);
  return running && started ? stillWorkingAt(label, (now - started) / 1000, tries) : null;
}
