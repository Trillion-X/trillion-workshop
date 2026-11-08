// tools/suggest-zooms-from-pointer-moves/read-data/auto-zoom.mjs (moved from Trillion computer/auto-zoom.mjs)
//
// Purpose
//   Turns pointer telemetry recorded beside a screen recording into zoom suggestions with one generic dwell/click
//   detector, thresholds in DATA (read-data/auto-zoom.json), and gives a compositor the flags to apply them. Suggestions
//   are plain rows the person can edit before export.
//
// Non-negotiable invariants
//   1. Thresholds, bands, zoom levels and flags are DATA; this file knows no recording tool.
//   2. The telemetry must say its coordinate space (normalized-source); a sidecar in another space or without one is
//      refused rather than guessed, so a zoom can never point at the wrong place.
//   3. The detector is deterministic: the same samples always give the same suggestions, sorted, and none overlap.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/suggest-zooms-from-pointer-moves/read-data/auto-zoom.mjs suggest
//
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const zoomSettings = () => JSON.parse(readFileSync(path.join(HERE, 'auto-zoom.json'), 'utf8'));
const SPACE = 'normalized-source';

const positionAt = (moves, t) => {
  let found = moves[0];
  for (const move of moves) { if (move.t <= t) found = move; else break; }
  return found;
};

/** Suggestions [{ start_ms, end_ms, x, y, strength, zoom, clicks }] from a sidecar { space, samples }. */
export function suggestZooms(sidecar, settings = zoomSettings()) {
  if (sidecar?.space !== SPACE) throw Object.assign(new Error(`The telemetry is in the space ${sidecar?.space ?? 'unknown'}, not ${SPACE}.`), { status: 400 });
  const moves = sidecar.samples.filter(sample => sample.type === 'move' || sample.type === 'click').sort((a, b) => a.t - b.t);
  if (!moves.length) return [];
  const step = settings.step_seconds * 1000; const end = moves.at(-1).t;
  const found = [];
  for (let t = moves[0].t; t <= end;) {
    const anchor = positionAt(moves, t); let stop = t;
    for (let at = t; at <= end && at - t <= settings.most_ms; at += step) {
      const here = positionAt(moves, at);
      if (Math.hypot(here.x - anchor.x, here.y - anchor.y) > settings.radius) break;
      stop = at;
    }
    if (stop - t >= settings.least_ms) {
      const clicks = moves.filter(sample => sample.type === 'click' && sample.t >= t && sample.t <= stop).length;
      const length = stop - t;
      let index = settings.bands.findIndex(band => band.under_ms === null || length < band.under_ms);
      if (clicks) index = Math.min(settings.bands.length - 1, index + 1);
      const strength = settings.bands[index].id;
      found.push({ start_ms: Math.round(t), end_ms: Math.round(stop), x: anchor.x, y: anchor.y, strength, zoom: settings.levels[strength], clicks });
      t = stop + step;
    } else t += step * 5;
  }
  return found.reduce((merged, zoom) => {
    const last = merged.at(-1);
    if (last && zoom.start_ms - last.end_ms <= settings.merge_gap_ms && Math.hypot(zoom.x - last.x, zoom.y - last.y) <= settings.radius) { last.end_ms = zoom.end_ms; last.clicks += zoom.clicks; return merged; }
    return [...merged, { ...zoom }];
  }, []);
}

/** The compositor's command-line words for a telemetry file and the (possibly edited) suggestions. */
export const exportFlags = (settings, file, zooms) => settings.export_flags.map(word => fill(word, { file, zooms: JSON.stringify(zooms) }));

export const zoomTools = {
  /** { sidecar } or { recording } -> { zooms } */
  async suggest(input) {
    // A recording made by Trillion's computer/capture-session.mjs (deleted) had its pointer sidecar beside it; the Workshop row
    // offers the sidecar given whole, since reading a file beside a recording would need a folder grant (README, Not yet).
    const file = input.recording ? `${input.recording}.pointer.json` : null;
    if (file && !existsSync(file)) throw Object.assign(new Error(`There is no pointer note beside ${input.recording}.`), { status: 404 });
    return { zooms: suggestZooms(file ? JSON.parse(readFileSync(file, 'utf8')) : input.sidecar) };
  },
};

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { suggest } = zoomTools;
