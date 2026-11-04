// parts/guided-overlay/show/walkthroughs.ts
//
// The part's public face for an app shell and its screens: `emitWalkthroughEvent`, the
// one channel a screen uses to say something happened that a tour may start on, and
// what a list of tours shows, from the same folds and start channel the always-on
// WalkthroughHost uses (no React is loaded here): each tour, whether this person finished it, how many steps it
// has, and the event that starts it again. A screen draws these rows in its own words;
// adding a tour is one DATA definition and this needs no edit.

import { foldWalkthroughProgress, foldWalkthroughRecords, tourFacts } from '../read-data/walkthrough-eeaf';
import { selectTrigger, startEventForWalkthrough, type HostEvent } from '../engine/trigger-intake';
import { commitWalkthroughProgress } from '../do-work/walkthrough-progress';
import { showOf, type ShowRuleSummary } from '../../ui/show/show-rules/show-of';
import defaults from '../guided-overlay-defaults.json';
import { emitWalkthroughEvent, emitWalkthroughEventWhenShown, toWalkthroughRecords } from './walkthrough-events';

/** The show-rules subject a tour is asked under (src/workspace/show-rules.json `subjects`), the same the host asks. */
export const TOUR_SUBJECT = 'tour';

export { emitWalkthroughEvent, emitWalkthroughEventWhenShown };
export type { HostEvent };

export function emitWalkthroughEventWhenHostReady(detail: HostEvent): () => void {
  if (typeof window === 'undefined') return () => {};
  const eventName = 'bitfield:walkthrough-host-available';
  let stopped = false;
  const send = () => { if (!stopped) emitWalkthroughEvent(detail); };
  window.addEventListener(eventName, send, { once: true });
  queueMicrotask(send);
  return () => { stopped = true; window.removeEventListener(eventName, send); };
}

export interface WalkthroughListing {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: number;
  readonly finished: boolean;
  readonly startEvent: HostEvent | null;
  /** When the change a tour shows landed: the newest `consumed_before` its triggers ask of an earlier tour (a What is
   *  new tour opens for people who took the first tour before then). Null for a tour about no change. */
  readonly changedAt: string | null;
}

function changedAt(triggers: unknown): string | null {
  const times = (Array.isArray(triggers) ? triggers : []).flatMap((trigger) =>
    (Array.isArray(trigger?.requires) ? trigger.requires : []).map((need: { consumed_before?: unknown }) => need?.consumed_before))
    .filter((time): time is string => typeof time === 'string' && !Number.isNaN(Date.parse(time)));
  return times.length ? times.reduce((newest, time) => (Date.parse(time) > Date.parse(newest) ? time : newest)) : null;
}

/** Every tour in `definitions` with where this person stands in it (`progress` is their progress record). */
export function listWalkthroughs(definitions: unknown, progress: unknown): WalkthroughListing[] {
  const defs = foldWalkthroughRecords(toWalkthroughRecords(definitions));
  const state = foldWalkthroughProgress([{ address: '', value_json: progress }]);
  const rank = (order: unknown) => (typeof order === 'number' && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY);
  return Object.values(defs).sort((left, right) => rank(left.order) - rank(right.order)).map((def) => ({
    id: def.id,
    title: def.title ?? def.id,
    summary: def.summary ?? '',
    steps: def.steps.length,
    finished: state.cursors[def.id]?.status === 'complete',
    startEvent: startEventForWalkthrough(def.triggers, def.id),
    changedAt: changedAt(def.triggers),
  }));
}

/** Start one listed tour, in place of any tour already running; false only when no host is listening. */
export function startListedWalkthrough(listing: WalkthroughListing): boolean {
  return listing.startEvent ? emitWalkthroughEvent(listing.startEvent) : false;
}

/** One tour waiting to start by itself the next time Trillion opens, as the person's show rules leave it. */
export interface WaitingWalkthrough {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The facts the rules decided over (reason, urgency, hours since one like it). */
  readonly facts: Record<string, unknown>;
  readonly urgency: string;
  /** Whether a rule holds it now, and which rules and until when. */
  readonly held: boolean;
  readonly heldBy: readonly ShowRuleSummary[];
  readonly until: string | null;
  /** The key its trigger marks seen when it is closed, dismissed or finished. */
  readonly onceKey: string | null;
  readonly entryStep: string;
  readonly revision: number;
}

/**
 * Every tour that would start by itself on `event` (opening Trillion, by default), with how the person's show rules
 * leave it now: the same trigger fold, facts and rules the always-on host asks before it starts one, so this list and
 * what shows can never disagree. Nothing here names a tour, a reason or a rule.
 */
export function waitingWalkthroughs(definitions: unknown, progress: unknown, { event = { event_kind: 'app-opened' } as HostEvent, now = Date.now() } = {}): WaitingWalkthrough[] {
  const defs = foldWalkthroughRecords(toWalkthroughRecords(definitions));
  const state = foldWalkthroughProgress([{ address: '', value_json: progress }]);
  const waiting: WaitingWalkthrough[] = [];
  for (const def of Object.values(defs)) {
    const trigger = selectTrigger(def.triggers, event, state.consumedOnceKeys, state.consumedAt);
    if (!trigger) continue;
    const facts = tourFacts(defs, def.id, trigger, state.consumedAt, { now, urgencyWhenUnset: defaults.urgency.when_unset });
    const answer = showOf(TOUR_SUBJECT, facts);
    waiting.push({
      id: def.id, title: def.title ?? def.id, summary: def.summary ?? '', facts, urgency: String(facts.urgency ?? defaults.urgency.when_unset),
      held: answer.hidden, heldBy: answer.rules, until: answer.until, onceKey: trigger.once_key ?? null, entryStep: def.entry_step, revision: def.revision ?? 1,
    });
  }
  return waiting;
}

/**
 * Marks the given waiting tours seen without showing them (Dismiss): one move in the person's progress record, the same
 * record closing a tour writes, so none of them starts by itself again; each can still be shown by name from Tours.
 */
export async function dismissWalkthroughs(waiting: readonly WaitingWalkthrough[]): Promise<boolean> {
  const keyed = waiting.filter((tour) => tour.onceKey);
  if (!keyed.length) return false;
  const [first, ...rest] = keyed;
  const receipt = await commitWalkthroughProgress({
    run_id: `dismissed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    definition_id: first.id, definition_revision: first.revision, expected_cursor_revision: 0,
    from_step_id: first.entryStep, to_step_id: first.entryStep, history: [], status: 'complete', cause: 'advance',
    once_key: first.onceKey, also_once_keys: rest.map((tour) => tour.onceKey as string),
  });
  return receipt.accepted;
}
