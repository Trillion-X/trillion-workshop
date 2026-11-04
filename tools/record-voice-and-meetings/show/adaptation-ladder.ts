// parts/record-audio/show/adaptation-ladder.ts
//
// Purpose
//   Gives the live-words stream (live-audio-stream.ts) its adaptation: readings of how the connection is doing step it down
//   or up the ladder one rung at a time, each change told by a named event, and the endpoint it opens is chosen with a
//   persisted cooldown for one that just failed. Both are rows of adaptation-ladder.json.
//
// Non-negotiable invariants
//   1. One rung at a time, and only after the DATA's count of readings in a row; a lone bad reading never moves it.
//   2. The lowest rung is never stepped below: that is told as too_low_to_downgrade, once per run of bad readings.
//   3. A failed endpoint is skipped until its cooldown ends, however many pages are opened; when every endpoint is cooling
//      the first is used rather than none.
//   4. The rungs come from live-audio-stream.json; this file keeps no list of them.

import streamData from './live-audio-stream.json' with { type: 'json' };
import data from './adaptation-ladder.json' with { type: 'json' };

export type LadderEvent = keyof typeof data.events;
export type Reading = { backlog?: number; lost?: boolean };
export type Cooling = Record<string, number>;
export type Store = { get(key: string): string | null; set(key: string, value: string): void };

const isBad = (reading: Reading, rows = data) => reading.lost === true || (reading.backlog ?? 0) > rows.bad.backlog_bytes;

/** Steps `rung` (an index into the stream's ladder) from readings; `onChange` hears the new rung and the event's name and words. */
export function createLadder(onChange: (change: { rung: number; event: LadderEvent; says: string }) => void, rows = data, rungs: number = streamData.ladder.length) {
  let rung = 0;
  let bad = 0;
  let good = 0;
  let toldLowest = false;
  const tell = (event: LadderEvent) => onChange({ rung, event, says: rows.events[event] });
  return {
    rung: () => rung,
    observe(reading: Reading) {
      if (isBad(reading, rows)) {
        good = 0;
        bad += 1;
        if (bad < rows.step_down_after_bad) return;
        if (rung >= rungs - 1) { if (!toldLowest) { toldLowest = true; tell('too_low_to_downgrade'); } bad = 0; return; }
        rung += 1;
        bad = 0;
        tell('downgrade_once');
        return;
      }
      bad = 0;
      toldLowest = false;
      good += 1;
      if (rung > 0 && good >= rows.recover_after_good) { rung -= 1; good = 0; tell('recovered'); }
    },
  };
}

const read = (store: Store, key: string): Cooling => {
  try { const value = JSON.parse(store.get(key) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
};

/** The endpoint to open now and the way to say one failed (left alone for the DATA's cooldown, kept in `store` across pages). */
export function createFailover(store: Store, rows = data.failover) {
  return {
    pick(now: number): { id: string; path: string } {
      const cooling = read(store, rows.store_key);
      return rows.endpoints.find(endpoint => !(cooling[endpoint.id] > now)) ?? rows.endpoints[0];
    },
    failed(id: string, now: number) {
      const cooling = Object.fromEntries(Object.entries(read(store, rows.store_key)).filter(([, until]) => until > now));
      cooling[id] = now + rows.cooldown_ms;
      store.set(rows.store_key, JSON.stringify(cooling));
    },
  };
}

/** The page's own storage when it allows one (a private window may not), else a store that lasts as long as the page. */
export function pageStore(): Store {
  const memory = new Map<string, string>();
  try {
    const kept = globalThis.localStorage;
    kept.setItem(data.failover.store_key, kept.getItem(data.failover.store_key) ?? '{}');
    return { get: key => kept.getItem(key), set: (key, value) => kept.setItem(key, value) };
  } catch {
    return { get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value); } };
  }
}
