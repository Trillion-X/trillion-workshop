// src/workspace/felt-speed-rows.mjs
//
// PURPOSE
//   The arithmetic of how fast Trillion feels (src/workspace/felt-speed.ts): a timing kept among a moment's last ones on
//   this device, and the row a device writes to the person's list from them (felt-speed.json `list`). Kept apart from
//   the page so it reads the same in node, where its test runs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a moment: each comes from felt-speed.json, and an unknown one keeps nothing.
//   2. A device keeps at most `kept_samples` timings of a moment, the newest; a timing past `wait_most_ms` is kept as
//      `wait_most_ms`.
//   3. One row per moment (and per screen, for a screen) per device: its id is made of those, so writing it again
//      replaces it.
//
import settings from './felt-speed.json' with { type: 'json' };

export const feltSettings = settings;
const MOMENTS = new Map(settings.moments.map(moment => [moment.id, moment]));
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const at = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];

/** The kept timings with one more of `momentId` (about one screen, when `about` names it): `{ kept, key, moment }`, or
 *  null for a moment felt-speed.json does not name. `kept` is a new object; the one given is not changed. */
export function withTiming(kept, momentId, ms, about) {
  const moment = MOMENTS.get(momentId);
  if (!moment) return null;
  const key = about ? `${momentId}-${about}` : momentId;
  const before = kept[key] ?? { samples: [], written_at: 0 };
  const samples = [...before.samples, Math.round(Math.min(ms, settings.wait_most_ms))].slice(-settings.kept_samples);
  return { kept: { ...kept, [key]: { ...before, samples } }, key, moment };
}

/** When the row of `key` may be written next (ms since the epoch), from when it was last written. */
export const writeDueAt = (entry) => (entry?.written_at ?? 0) + settings.write_every_seconds * 1000;

/** The list row one device writes for one kept moment: the middle and slowest tenth of its kept timings, the last one,
 *  how many, and how long it may take. */
export function feltRow({ key, entry, moment, about, device, now }) {
  const sorted = [...entry.samples].sort((left, right) => left - right);
  return {
    id: slug(`${key}-${device}`),
    values: {
      moment: about ? `${moment.label}: ${about}` : moment.label,
      device,
      typical_ms: at(sorted, 0.5),
      slowest_ms: at(sorted, 0.9),
      last_ms: entry.samples[entry.samples.length - 1],
      times: entry.samples.length,
      budget_ms: moment.budget_ms,
      timed_at: now.toISOString(),
    },
  };
}
