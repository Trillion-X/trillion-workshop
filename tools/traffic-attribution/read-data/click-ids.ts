// tools/traffic-attribution/read-data/click-ids.ts
//
// Which visit signals are ad click ids, and how a missing one is filled. Every name comes from ad-return.json (DATA):
// a click id is one click or one browser, so it stays with the visitor's first touch (for sending a conversion back to
// the platform the click came from) and is never a breakdown. Pure: the cookie reader and the clock are passed in.

import settings from './ad-return.json' with { type: 'json' };

const CLICK_IDS: ReadonlySet<string> = new Set(settings.click_ids);

/** Whether a signal is an ad click id (never offered as a breakdown). */
export function isClickIdSignal(key: string): boolean {
  return CLICK_IDS.has(key);
}

/** The click ids among a visit's signals. */
export function clickIdsOf(signals: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(signals ?? {}).filter(([key, value]) => CLICK_IDS.has(key) && typeof value === 'string' && value.trim()));
}

/**
 * The click ids a page keeps in cookies, then the ones derived from another click id by the platform's own format,
 * each only where the signals do not already carry it. `atMs` is when the click was seen; with no time nothing is
 * derived, since a made-up time would misdate the click.
 */
export function clickIdsToAdd(
  signals: Record<string, string>,
  { getCookie, atMs }: { getCookie?: (name: string) => string | null | undefined; atMs?: number },
): Record<string, string> {
  const added: Record<string, string> = {};
  const has = (key: string) => Boolean(signals[key] || added[key]);
  for (const { signal, cookie } of settings.cookie_click_ids) {
    if (has(signal) || !getCookie) continue;
    const value = (getCookie(cookie) ?? '').trim();
    if (value) added[signal] = value;
  }
  for (const { signal, from, format } of settings.derived_click_ids) {
    const source = (signals[from] ?? added[from] ?? '').trim();
    if (has(signal) || !source || typeof atMs !== 'number' || !Number.isFinite(atMs)) continue;
    added[signal] = format.replace('{at_ms}', String(Math.trunc(atMs))).replace('{value}', source);
  }
  return added;
}
