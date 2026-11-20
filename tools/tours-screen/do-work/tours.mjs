// tools/tours-screen/do-work/tours.mjs
//
// PURPOSE
//   The rows of the Tours screen, run by tools/workflows/do-work/run-a-function.mjs over the records the caller hands in
//   (the person's AI read them from the store that holds them; the tool has no records door and keeps nothing): list
//   the workspace tours with where the person stands in each, list the tours waiting to start by themselves with how the
//   person's show rules leave each one, and dismiss waiting tours (mark them seen without showing them). A person, an AI
//   and a wake run the same rows, so each answer is the one the Tours screen gives.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the tour host's own, moved from old trillion tools/guided-overlay: the definitions and progress
//      folds and tourFacts (read-data/walkthrough-eeaf.ts), the trigger choice (engine/trigger-intake.ts), and the one
//      progress move (do-work/walkthrough-progress.ts applyProgressTransition). The show rules are the person's own
//      `show-rules` record (handed in as `show_rules`) decided by tools/set-up-my-account showDecision, the reader the
//      page's answerer uses. So this
//      list and what the host shows can never disagree. listTours, waitingTours and dismissWaitingTours are the bodies of
//      show/walkthroughs.ts listWalkthroughs, waitingWalkthroughs and dismissWalkthroughs over those reads.
//   2. Nothing here names a tour, a reason, a rule or a step: the records and read-data/tours.json say them.
//   3. Nothing is written: dismissing answers `keep`, the progress record it would write, with the `progress` handed in as
//      `expected`, for the caller to keep. A progress record changed meanwhile is not written over.
//   4. The app's own tours live in the page, not in the person's records: a caller that has them passes them as `tours`;
//      the person's own (the tours their AIs wrote, read-data/tours.json `tours_label`) come as `own_tours`, the progress
//      record (read-data/tours.json `progress_label`) as `progress` and the `show-rules` record as `show_rules`; each
//      is left out when the person has none.
//
import { readFileSync } from 'node:fs';
import settings from '../read-data/tours.json' with { type: 'json' };
import defaults from '../guided-overlay-defaults.json' with { type: 'json' };
import showRules from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import { showDecision } from '../../set-up-my-account/read-data/show-rules.mjs';
import { foldWalkthroughProgress, foldWalkthroughRecords, tourFacts } from '../read-data/walkthrough-eeaf.ts';
import { selectTrigger, startEventForWalkthrough } from '../engine/trigger-intake.ts';
import { applyProgressTransition } from './walkthrough-progress.ts';

// show/walkthroughs.ts TOUR_SUBJECT: the show-rules subject a tour is decided as.
export const TOUR_SUBJECT = 'tour';
const OPENED = { event_kind: 'app-opened' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;

// A row the caller hands over that is not an object reads as no facts, as the row filter always read it.
const asRecord = row => (row && typeof row === 'object' ? row : {});
let loaded = null;
async function rowFilter() {
  if (!loaded) loaded = (async () => {
    initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
    return ({ tree, fields, rows }) => filterRecords({ records: rows.map(asRecord), fields, tree });
  })();
  return loaded;
}

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

function eventOf(input) {
  if (input.event === undefined) return OPENED;
  if (!object(input.event) || !word(input.event.event_kind)) throw new Error('event is { event_kind, ... }, such as { "event_kind": "app-opened" }.');
  return input.event;
}

/** The tours, the progress and the show rules the request carries; a record left out is null. */
function readTours(input) {
  if (!object(input)) throw new Error('The request is one object.');
  if (input.tours !== undefined && !Array.isArray(input.tours)) throw new Error('tours is a list of walkthrough definitions (the app\'s own tours, when the caller has them).');
  if (input.own_tours !== undefined && !Array.isArray(input.own_tours)) throw new Error('own_tours is the list of walkthrough definitions your AIs wrote (the value of the record guided-overlay::own-walkthroughs).');
  const own = input.own_tours ?? [];
  // show/walkthrough-events.ts toWalkthroughRecords: each definition is one record of the fold.
  const definitions = [...(input.tours ?? []), ...own].map(value => ({ address: '', value_json: value }));
  const ownIds = new Set(own.map(tour => tour?.id).filter(word));
  return { defs: foldWalkthroughRecords(definitions), progress: input.progress ?? null, rules: input.show_rules ?? null, ownIds };
}

function changedAt(triggers) {
  const times = (Array.isArray(triggers) ? triggers : []).flatMap(trigger =>
    (Array.isArray(trigger?.requires) ? trigger.requires : []).map(need => need?.consumed_before))
    .filter(time => typeof time === 'string' && !Number.isNaN(Date.parse(time)));
  return times.length ? times.reduce((newest, time) => (Date.parse(time) > Date.parse(newest) ? time : newest)) : null;
}

/** tool:list-workspace-tours (show/walkthroughs.ts listWalkthroughs) */
export function listTours(input = {}) {
  const { defs, progress, ownIds } = readTours(input);
  const state = foldWalkthroughProgress([{ address: '', value_json: progress }]);
  const rank = order => (typeof order === 'number' && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY);
  const tours = Object.values(defs).sort((left, right) => rank(left.order) - rank(right.order)).map(def => ({
    tour_id: def.id,
    title: def.title ?? def.id,
    summary: def.summary ?? '',
    steps: def.steps.length,
    finished: state.cursors[def.id]?.status === 'complete',
    start_event: startEventForWalkthrough(def.triggers, def.id),
    changed_at: changedAt(def.triggers),
    own: ownIds.has(def.id),
  }));
  const finished = tours.filter(tour => tour.finished).length;
  return { tours, said: `${tours.length} tour${tours.length === 1 ? '' : 's'}, ${finished} finished.` };
}

/** The waiting tours as the host decides them (show/walkthroughs.ts waitingWalkthroughs). */
async function waitingOf(read, input) {
  const { defs, progress, rules } = read;
  const state = foldWalkthroughProgress([{ address: '', value_json: progress }]);
  const now = nowOf(input);
  const event = eventOf(input);
  const filterRows = await rowFilter();
  const waiting = [];
  for (const def of Object.values(defs)) {
    const trigger = selectTrigger(def.triggers, event, state.consumedOnceKeys, state.consumedAt);
    if (!trigger) continue;
    const facts = tourFacts(defs, def.id, trigger, state.consumedAt, { now, urgencyWhenUnset: defaults.urgency.when_unset });
    const answer = await showDecision({ data: showRules, record: rules, subject: TOUR_SUBJECT, thing: facts, now, filterRows });
    waiting.push({
      tour_id: def.id, title: def.title ?? def.id, summary: def.summary ?? '', facts, urgency: String(facts.urgency ?? defaults.urgency.when_unset),
      held: answer.hidden, held_by: answer.rules, until: answer.until, once_key: trigger.once_key ?? null, entry_step: def.entry_step, revision: def.revision ?? 1,
    });
  }
  return waiting;
}

/** tool:list-waiting-tours */
export async function waitingTours(input = {}) {
  const waiting = await waitingOf(readTours(input), input);
  const held = waiting.filter(tour => tour.held).length;
  return { waiting, said: waiting.length ? `${waiting.length} tour${waiting.length === 1 ? '' : 's'} waiting, ${held} held by your show rules.` : 'No tour is waiting to start by itself.' };
}

/** tool:dismiss-waiting-tours (show/walkthroughs.ts dismissWalkthroughs): one move in the progress record, as `keep`. */
export async function dismissWaitingTours(input = {}) {
  if (input.tour_ids !== undefined && (!Array.isArray(input.tour_ids) || !input.tour_ids.every(word))) throw new Error('tour_ids is a list of tour_id from list-waiting-tours; leave it out to dismiss every waiting tour.');
  const read = readTours(input);
  const waiting = await waitingOf(read, input);
  const asked = input.tour_ids ? new Set(input.tour_ids) : null;
  if (asked) {
    const missing = [...asked].filter(id => !waiting.some(tour => tour.tour_id === id));
    if (missing.length) throw new Error(`Not waiting now: ${missing.join(', ')}. list-waiting-tours gives every tour_id waiting.`);
  }
  const keyed = waiting.filter(tour => (!asked || asked.has(tour.tour_id)) && tour.once_key);
  if (!keyed.length) return { dismissed: [], keep: [], said: 'Nothing to dismiss: no waiting tour has a key that keeps it from starting again.' };
  const [first, ...rest] = keyed;
  const now = new Date(nowOf(input)).toISOString();
  const { state, receipt } = applyProgressTransition(read.progress, {
    run_id: `dismissed-${Date.parse(now).toString(36)}-${keyed.map(tour => tour.tour_id).join('.').length.toString(36)}`,
    definition_id: first.tour_id, definition_revision: first.revision, expected_cursor_revision: 0,
    from_step_id: first.entry_step, to_step_id: first.entry_step, history: [], status: 'complete', cause: 'advance',
    once_key: first.once_key, also_once_keys: rest.map(tour => tour.once_key),
  }, now);
  if (!receipt.accepted) return { dismissed: [], keep: [], said: 'Your tour progress moved meanwhile; read the waiting tours again.' };
  const dismissed = keyed.map(tour => tour.tour_id);
  return {
    dismissed,
    keep: [{ label: settings.progress_label, value: state, expected: read.progress }],
    said: `Dismissed ${dismissed.length} tour${dismissed.length === 1 ? '' : 's'}; each can still be shown by name from Tours.`,
  };
}
