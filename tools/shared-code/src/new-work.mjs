// src/new-work.mjs
//
// PURPOSE
//   What is new for the person on each screen since they last looked there, and the newest things their AIs made, read
//   from the one record of what each AI did (src/activity.mjs) against one seen mark per screen (src/seen-marks.mjs,
//   the same marks spaces count unread from). The sidebar shows each count on its screen's row; Home shows the
//   newest things as the New for you strip; showing a screen marks it seen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no tool, no screen and no kind of thing: which acts count where, the window and the strip are
//      DATA (src/new-work.json). A count from anywhere other than the activity record comes from `elsewhere`, a map the
//      store hands in keyed by the row's `source`; a source nobody handed in is left out, never guessed.
//   2. Only what an AI did counts: a row made on the person's own page (activity-marks.json person_app) or one that
//      failed is never new work.
//   3. Reading walks the record newest first and stops at the oldest time any screen counts from, so a read costs what
//      is new, never the whole record. A warm store keeps the counts and strip it walked and reads only the rows kept
//      since (seq above the newest it read); the window's start moves in steps of `window_step_minutes`, so a busy
//      record whose oldest row ages out every few seconds is walked whole once a step, not on every read.
//   4. A screen's count starts again when the person has seen it; a screen never seen, or seen long ago, counts only
//      the last `window_days` days.

import settings from './new-work.json' with { type: 'json' };
import { activityResets, activityTable, PERSON_APP, visibleActivity } from '../../see-what-my-ais-did/activity.mjs';
import { seenMarks } from './seen-marks.mjs';
import { WorkFailure } from './failure.mjs';

/** Where the person's seen mark on each screen is kept. */
export const SCREEN_SEEN = { table: 'screen_seen', place: 'surface', reader: 'reader' };
const READER = 'person';
const DAY_MS = 86400000;
// A Durable Object keeps its SQL handle while it is warm, so the derived counts and strip are kept and extended by the
// rows written since (invariant 3). A store reset, a dropped activity generation, a seen mark, a new window step or
// changed DATA walks the window again. Counts supplied by other owners are always read fresh.
const READS = new WeakMap();

const byAnAI = row => row.ok !== false && row.app !== PERSON_APP;
const counted = (rule, row) => (rule.tools === 'every' || rule.tools.includes(row.tool))
  && (!rule.where || rule.where.starts_with.some(start => String(row.facts?.[rule.where.fact] ?? '').startsWith(start)));
const fromActivity = rule => (rule.source ?? 'activity') === 'activity';

/**
 * { counts: { surface: n }, clears_on_show: [surface], items: [...], seen: { surface: seen_at } }. `items` are the
 * newest things an AI made (strip DATA), each with `new` when it came after the person last saw the strip's screen.
 * `elsewhere` maps a count row's `source` to an async function answering its number.
 */
export async function readNewWork(sql, { now = new Date(), elsewhere = {}, config = settings } = {}) {
  activityTable(sql);
  const seen = seenMarks(sql, SCREEN_SEEN).marksOf(READER);
  const time = now.getTime();
  const seenKey = JSON.stringify(seen);
  const configKey = JSON.stringify(config);
  const windowMs = config.window_days * DAY_MS;
  const stepMs = Math.max(1, config.window_step_minutes ?? 1) * 60_000;
  const windowStart = new Date(Math.floor((time - windowMs) / stepMs) * stepMs).toISOString();
  const kept = { resets: activityResets(sql), visible: visibleActivity(sql), seenKey, configKey, windowStart };
  let cached = READS.get(sql);
  const since = surface => (seen[surface] && seen[surface] > windowStart ? seen[surface] : windowStart);
  const rules = config.counts.filter(fromActivity).map(rule => ({ rule, since: since(rule.surface) }));
  const stripTools = new Set(config.strip.tools);
  const stripSince = since(config.strip.surface);
  if (!cached || Object.entries(kept).some(([key, value]) => cached[key] !== value)) {
    cached = { ...kept, seq: 0, counts: Object.fromEntries(rules.map(({ rule }) => [rule.surface, 0])), items: [],
      clears_on_show: rules.map(({ rule }) => rule.surface) };
  }
  // Only the rows kept since the last read (all of the window on the first). The time predicate also handles
  // backdated writes: insertion order need not equal event time.
  const fresh = [];
  let newest = cached.seq;
  for (const { seq, row: text } of sql.exec('SELECT seq, row FROM activity WHERE at > ? AND seq > ? ORDER BY seq DESC', windowStart, cached.seq)) {
    newest = Math.max(newest, seq);
    const row = JSON.parse(text);
    if (!byAnAI(row)) continue;
    for (const { rule, since: from } of rules) if (row.at > from && counted(rule, row)) cached.counts[rule.surface] += 1;
    if (stripTools.has(row.tool) && row.item) fresh.push({
      seq, tool: row.tool, item: row.item, title: row.title ?? null, label: row.label, app: row.app, agent: row.agent ?? null,
      at: row.at, opens: row.opens ?? null, media_type: row.facts?.media_type ?? null, look: config.looks[row.tool] ?? null,
      new: row.at > stripSince,
    });
  }
  // The strip: the newest row of each thing, newest first, the rows just read ahead of the ones kept.
  const shown = new Set();
  cached.items = [...fresh, ...cached.items].filter(item => !shown.has(item.item) && shown.add(item.item)).slice(0, config.strip.count);
  cached.seq = newest;
  READS.set(sql, cached);
  const counts = { ...cached.counts };
  for (const rule of config.counts.filter(rule => !fromActivity(rule))) {
    const read = elsewhere[rule.source];
    if (read) counts[rule.surface] = await read();
  }
  return { counts, clears_on_show: [...cached.clears_on_show], items: cached.items.map(item => ({ ...item })), seen };
}

/** The person has now seen `surface`: its count starts again. Only a screen whose count this record keeps is marked. */
export function markScreenSeen(sql, surface, { now = new Date(), config = settings } = {}) {
  if (!config.counts.some(rule => fromActivity(rule) && rule.surface === surface)) throw new WorkFailure('request-refused', 'That screen has nothing to mark seen.');
  return { surface, seen_at: seenMarks(sql, SCREEN_SEEN).mark(surface, READER, now.toISOString()) };
}
