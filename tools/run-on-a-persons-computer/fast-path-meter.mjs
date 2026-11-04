// computer/fast-path-meter.mjs
//
// PURPOSE
//   Counts how each ask to a fast path was served (first choice, fallback, none) with the reason it fell back, and says
//   when most asks in the last window did not get the first choice (a storm), so a silent fallback is visible instead of
//   only slow. The numbers are computer/fast-path-meter.json. Pure: the clock is given, nothing is written anywhere.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no path, model or reason: they are the strings callers give it.
//   2. A sample outside the window is not counted; at most max_samples are kept per path (the oldest go first).
//   3. A storm needs min_samples asks in the window, so a single failed ask never reports one.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const meterSettings = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fast-path-meter.json'), 'utf8'));

export function makeFastPathMeter({ settings = meterSettings(), now = () => Date.now() } = {}) {
  const samples = new Map();
  const live = path => {
    const rows = (samples.get(path) ?? []).filter(row => row.at > now() - settings.window_seconds * 1000);
    samples.set(path, rows);
    return rows;
  };
  return {
    /** One ask: outcome is served | fallback | unserved; reason says why the first choice did not answer. */
    record(path, outcome, reason = null) {
      const rows = live(path);
      rows.push({ at: now(), outcome, reason });
      if (rows.length > settings.max_samples) rows.splice(0, rows.length - settings.max_samples);
    },
    /** { asks, served, fell_back, unserved, ratio, storm, reasons } for the window; reasons are the commonest, with counts. */
    report(path) {
      const rows = live(path);
      const count = outcome => rows.filter(row => row.outcome === outcome).length;
      const not = rows.length - count('served');
      const reasons = new Map();
      for (const row of rows) if (row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
      const ratio = rows.length ? not / rows.length : 0;
      return { asks: rows.length, served: count('served'), fell_back: count('fallback'), unserved: count('unserved'), ratio: Math.round(ratio * 100) / 100,
        storm: rows.length >= settings.min_samples && ratio >= settings.storm_ratio,
        reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, settings.max_reasons).map(([reason, times]) => ({ reason, times })) };
    },
  };
}
