// parts/ui/show/record-views/arrivals.ts
//
// PURPOSE
//   Mark a small number of records that appear after a list has drawn, so the person can find what arrived from an AI
//   or another device. Initial records and changes to the filter are not arrivals.

import { useEffect, useRef, useState, type RefObject } from 'react';
import policy from './arrivals.json';

const ARRIVAL_LIMIT = policy.max_arrivals;

function arrivalLifetime(surface: HTMLElement | null): number {
  // A computed animation duration resolves the Screen Look's calc() and reduced-motion scale.
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.animationDuration = 'var(--motion-arrival)';
  (surface ?? document.documentElement).append(probe);
  const token = getComputedStyle(probe).animationDuration;
  probe.remove();
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(token);
  const duration = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 0;
  return Math.max(0, duration) + policy.cleanup_margin_ms;
}

type ArrivalState = { listKey: string; ids: ReadonlySet<string> };
const EMPTY: ReadonlySet<string> = new Set();

export function useArrivals(listKey: string, ids: readonly string[], surface: RefObject<HTMLElement | null>): ReadonlySet<string> {
  const seen = useRef<{ listKey: string; ids: Set<string> } | null>(null);
  const timers = useRef(new Set<number>());
  const [state, setState] = useState<ArrivalState>({ listKey, ids: EMPTY });

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  useEffect(() => {
    const previous = seen.current;
    if (!previous || previous.listKey !== listKey) {
      if (previous) {
        for (const timer of timers.current) window.clearTimeout(timer);
        timers.current.clear();
      }
      seen.current = { listKey, ids: new Set(ids) };
      setState({ listKey, ids: EMPTY });
      return;
    }

    const priorIds = previous.ids;
    // Keep only the current source snapshot: list history can grow without bound.
    seen.current = { listKey, ids: new Set(ids) };
    const fresh = ids.filter(id => !priorIds.has(id));
    if (!fresh.length || fresh.length > ARRIVAL_LIMIT) return;

    setState(current => ({ listKey, ids: new Set([...new Set([...(current.listKey === listKey ? current.ids : []), ...fresh])].slice(-ARRIVAL_LIMIT)) }));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setState(current => {
        if (current.listKey !== listKey) return current;
        const remaining = new Set(current.ids);
        for (const id of fresh) remaining.delete(id);
        return { listKey, ids: remaining };
      });
    }, arrivalLifetime(surface.current));
    timers.current.add(timer);
  }, [listKey, ids]);

  return state.listKey === listKey ? state.ids : EMPTY;
}
