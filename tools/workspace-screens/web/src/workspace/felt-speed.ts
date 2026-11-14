// src/workspace/felt-speed.ts
//
// PURPOSE
//   How long the person actually waited, timed in their own sessions and kept where every AI reads it: from the moment
//   they asked (the page's first request, the key they pressed, the screen they opened) to the moment it showed. Each
//   device keeps its last timings of each moment on itself and writes one row per moment to the person's own list
//   (felt-speed.json `list`, read by any AI with read_list), so what the person feels is read beside what the proof
//   accounts measure, never instead of it. The arithmetic (what is kept, the row written) is felt-speed-rows.mjs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A moment, its words and how long it may take are DATA (felt-speed.json); a caller names the moment it times and
//      how the page shows it is done, nothing else.
//   2. Only what the person could see is kept: a wait during which the page was put away, or the connection was lost,
//      is dropped (the page stayed visible and online for all of a kept wait), and a wait past `wait_most_ms` is kept
//      as `wait_most_ms` (it was at least that long).
//   3. Timing never slows what it times: it reads the page once per frame, and a row is written at most once per
//      `write_every_seconds`, through the lists' records road with a quiet write that leaves every kept read standing
//      (list-records.ts ensureList and putRows, records-door.ts `quiet`).
//   4. A row that cannot be written (offline, a look-only visit) is written with the next one; nothing is ever shown
//      to the person about it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { ensureList, putRows } from './list-records';
import { thisDevice } from './device-facts';
import { feltRow, feltSettings as settings, withTiming, writeDueAt } from './felt-speed-rows.mjs';

/** The longest a wait is timed for (felt-speed.json). */
export const WAIT_MOST_MS = settings.wait_most_ms;

const KEPT = 'trillion-felt-speed';

type Kept = Record<string, { samples: number[]; written_at: number }>;
const read = (): Kept => {
  try { return JSON.parse(localStorage.getItem(KEPT) ?? '{}') as Kept; } catch { return {}; }
};
const keep = (kept: Kept) => { try { localStorage.setItem(KEPT, JSON.stringify(kept)); } catch { /* a full or closed store keeps nothing */ } };

/** Whether the page shows its screens: at least one pane, and no loading state left in any. */
export const panesShown = (): boolean =>
  document.querySelector('[data-trillion-screen]') !== null && document.querySelector('[data-trillion-screen] [data-screen-state="loading"]') === null;

/** Whether one screen's host shows the screen itself: something to read or see in it, and no loading state. */
export const screenShown = (host: Element): boolean =>
  host.querySelector('[data-screen-state="loading"]') === null && ((host.textContent ?? '').trim() !== '' || host.querySelector('img, svg, canvas, video') !== null);

const pending = new Map<string, ReturnType<typeof setTimeout>>();

async function write(key: string, moment: (typeof settings.moments)[number], about: string | undefined) {
  pending.delete(key);
  const entry = read()[key];
  if (!entry?.samples.length) return;
  try {
    const list = await ensureList(settings.list.id, settings.list, { quiet: true });
    await putRows(list, [feltRow({ key, entry, moment, about, device: thisDevice(), now: new Date() })], [], { quiet: true });
    const now = read();
    if (now[key]) { now[key].written_at = Date.now(); keep(now); }
  } catch { /* written with the next timing */ }
}

/** Keeps one timing of `moment` (about one screen, when `about` names it) and writes its row when it is due. */
export function keepFelt(momentId: string, ms: number, about?: string): void {
  const added = withTiming(read(), momentId, ms, about);
  if (!added) return;
  keep(added.kept);
  if (pending.has(added.key)) return;
  const due = Math.max(0, writeDueAt(added.kept[added.key]) - Date.now());
  pending.set(added.key, setTimeout(() => { void write(added.key, added.moment, about); }, due));
}

/** Times `moment` from `startedAt` (page time, as performance.now() and event.timeStamp read it) until `shown()` holds,
 *  read once per frame. Returns a stop for a wait that no longer matters (its pane closed). */
export function feltFrom(momentId: string, startedAt: number, shown: () => boolean, about?: string): () => void {
  // A wait is kept only when the page stayed visible and online for all of it (F-0090): a tab put away or a connection
  // lost mid-wait says nothing about how fast Trillion is.
  let stopped = document.visibilityState !== 'visible' || navigator.onLine === false;
  const away = () => { if (document.visibilityState !== 'visible') stopped = true; };
  const offline = () => { stopped = true; };
  document.addEventListener('visibilitychange', away);
  window.addEventListener('offline', offline);
  const end = () => { stopped = true; document.removeEventListener('visibilitychange', away); window.removeEventListener('offline', offline); };
  const look = () => {
    if (stopped) return end();
    const waited = performance.now() - startedAt;
    if (shown() || waited >= settings.wait_most_ms) { keepFelt(momentId, waited, about); return end(); }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
  return end;
}
