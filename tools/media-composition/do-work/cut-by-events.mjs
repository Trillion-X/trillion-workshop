/**
 * file: parts/media-composition/do-work/cut-by-events.mjs
 *
 * PURPOSE: Turns detected events (a stroke, a serve, the end of a point: { kind, time, confidence? }) into the parts of a
 * recording that are KEPT, and into the render EDL that cuts to them. The kept parts are src/range-edits.mjs ranges over the
 * original, so a cut can only keep positions of what was recorded. Whether to act on an event uses src/confidence-filter.mjs
 * (act, ask the person, or abstain); events from devices outside a multi-camera session (src/session-pairing.mjs) are ignored.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Blind: no sport, event kind or detector is named here. Padding, merge gap, floors and thresholds per kind are rows of
 *    cut-by-events.json; a new kind of event is a new row.
 * 2. Pure: the same events, rules and duration give the same kept ranges, asked and abstained lists.
 * 3. Nothing is invented: every kept range lies inside [0, duration]; an event that is not certain is returned as asked or
 *    abstained, with its reason, never silently kept or dropped.
 */
import settings from './cut-by-events.json' with { type: 'json' };
import { keptRanges, keptTotal, removedRanges } from './range-edits.mjs';
import { decide, filterEvents } from '../src/confidence-filter.mjs';
import { toFrame } from '../../calibrate-a-camera-frame/src/frame-calibration.mjs';
import { authorConcatEdl } from './author-concat-edl.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const round = value => Math.round(value * 10000) / 10000;

/**
 * { kept, removed, total, asked, abstained, dropped, said } for events over a recording `duration` seconds long.
 * `models` are second-stage rows for src/confidence-filter.mjs with `featuresOf`; `session` is a src/session-pairing.mjs session;
 * `frame` is a src/frame-calibration.mjs homography: an event with a position `at` ([x, y] in the picture) whose kind's rule has
 * `within_frame` is dropped when the position falls outside the calibrated frame (0..1 on both sides).
 */
export function cutByEvents({ events = [], duration, models = [], featuresOf = () => ({}), session = null, frame = null, config = settings } = {}) {
  const dropped = [];
  const rules = new Map(config.rules.map(row => [row.kind, row]));
  let usable = events.filter(event => {
    if (!finite(event?.time) || event.time < 0 || event.time > duration) { dropped.push({ event, reason: 'outside_recording' }); return false; }
    if (session && event.device !== undefined && !session.devices[event.device]) { dropped.push({ event, reason: 'other_device', said: config.words.other_device }); return false; }
    if (frame && rules.get(event.kind)?.within_frame && Array.isArray(event.at)) {
      const [x, y] = toFrame(frame, event.at);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) { dropped.push({ event, reason: 'outside_frame' }); return false; }
    }
    if (!rules.has(event.kind) && config.unknown_kind !== 'default') { dropped.push({ event, reason: 'unknown_kind' }); return false; }
    return true;
  });
  if (models.length) {
    const stage = filterEvents(usable, models, { contextOf: event => event.kind, featuresOf }, config);
    const kept = new Set(stage.map(row => row.event));
    for (const event of usable) if (!kept.has(event)) dropped.push({ event, reason: 'second_stage' });
    const scored = new Map(stage.map(row => [row.event, row.p]));
    usable = stage.map(row => (row.p === null ? row.event : { ...row.event, confidence: scored.get(row.event) }));
  }
  const acted = [], asked = [], abstained = [];
  for (const event of usable) {
    const rule = rules.get(event.kind) ?? config.default_rule;
    const unscored = !finite(event.confidence);
    if (unscored && config.unscored === 'abstain') { abstained.push({ event, reason: 'unscored' }); continue; }
    if (rule.min_confidence !== undefined && !unscored && event.confidence < rule.min_confidence) { abstained.push({ event, reason: 'below_kind_floor' }); continue; }
    const verdict = unscored ? 'act' : decide(event.confidence, config);
    if (verdict === 'act') acted.push(event);
    else if (verdict === 'ask') asked.push({ event, reason: 'needs_confirmation' });
    else abstained.push({ event, reason: 'low_confidence' });
  }
  const windows = acted.map(event => {
    const rule = rules.get(event.kind) ?? config.default_rule;
    return { start: Math.max(0, event.time - rule.before), end: Math.min(duration, event.time + rule.after) };
  }).filter(window => window.end - window.start > 0).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start - last.end <= config.merge_gap_s) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  const kept = keptRanges(merged.filter(window => window.end - window.start >= config.min_window_s).map(({ start, end }) => ({ start: round(start), end: round(end) })), duration);
  const said = [kept.length ? '' : config.words.no_events,
    abstained.length ? fill(config.words.abstained, { count: abstained.length }) : '',
    asked.length ? fill(config.words.asked, { count: asked.length }) : ''].filter(Boolean).join(' ');
  return { kept, removed: kept.length ? removedRanges(kept, duration) : [], total: round(keptTotal(kept)), asked, abstained, dropped, ...(said ? { said } : {}) };
}

/** The render EDL for a cut: the kept ranges as windows over one base recording (author-concat-edl.mjs). */
export function editFor({ baseArtifact, kept, encode }) {
  return authorConcatEdl({ baseArtifact, windows: kept, encode });
}
