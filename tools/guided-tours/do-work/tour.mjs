// tools/guided-tours: the guided-tour mechanism. A tour is an ordered, possibly branching list of steps; a cursor says
// where a person is in it; a step may carry an advance condition (what must be true before it moves on by itself); and
// a tour starts when an event matches one of its triggers. Everything here is pure: the same input gives the same
// answer and nothing is remembered between calls, so the caller keeps the cursor and the used-up suppression keys in
// its own records. The engine reads only a step's id and branch_map, a trigger's event and suppression key, and an
// advance condition's op and args. What a step shows, where it points and what a trigger's reason means pass through
// untouched: they are the tour author's data.

// ── Branches ────────────────────────────────────────────────────────────────

// Where a step goes next: the route its answer names, else the step's default, else the next step in list order.
// Null only at the end of a step with no branch map, which is completion.
export function resolveBranch(step, answer, orderedNext) {
  const map = step.branch_map;
  if (!map) return orderedNext;
  if (answer !== undefined && map.by_answer && Object.hasOwn(map.by_answer, answer)) return map.by_answer[answer];
  if (map.default_next !== undefined) return map.default_next;
  return orderedNext;
}

// ── The cursor ──────────────────────────────────────────────────────────────

const indexOfStep = (tour, id) => tour.steps.findIndex(step => step.id === id);
const orderedNextId = (tour, id) => tour.steps[indexOfStep(tour, id) + 1]?.id ?? null;

export const currentStep = (tour, cursor) => tour.steps.find(step => step.id === cursor.currentStepId) ?? null;

export const startTour = tour => ({ currentStepId: tour.entry_step, history: [], status: 'active' });
export const restart = startTour;

// Move on: by the step's branch map when it has one, else to the next step in order. No next step completes the tour,
// and the cursor stays on the last step shown. A finished cursor is returned as it was.
export function advance(tour, cursor, answer) {
  if (cursor.status === 'complete') return cursor;
  const step = currentStep(tour, cursor);
  if (!step) return { ...cursor, status: 'complete' };
  const next = resolveBranch(step, answer, orderedNextId(tour, step.id));
  if (next === null || indexOfStep(tour, next) < 0) return { ...cursor, status: 'complete' };
  return { currentStepId: next, history: [...cursor.history, cursor.currentStepId], status: 'active' };
}

// Go back to the step before, exactly, even across a branch. With nothing behind, the cursor is returned as it was.
export function retreat(cursor) {
  if (cursor.history.length === 0) return cursor;
  return { currentStepId: cursor.history.at(-1), history: cursor.history.slice(0, -1), status: 'active' };
}

// Go straight to a step (a replay list picking one). A step the tour does not have leaves the cursor as it was.
export function jump(tour, cursor, stepId) {
  if (indexOfStep(tour, stepId) < 0) return cursor;
  return { currentStepId: stepId, history: [...cursor.history, cursor.currentStepId], status: 'active' };
}

// ── Advance conditions ──────────────────────────────────────────────────────

const conditionsOf = value => (Array.isArray(value) ? value.filter(item => item && typeof item.op === 'string') : []);
const finiteOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

// A fact the caller already looked up is satisfied by a value in the shape the condition asks for.
function readbackValueSatisfied(value, args) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(args.required_values_present) && args.required_values_present.length > 0) {
    return Array.isArray(value) && args.required_values_present.every(required => value.includes(required));
  }
  if (args.required_nonempty === true) {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  }
  const accepted = Array.isArray(args.required_answer_values) ? args.required_answer_values : Array.isArray(args.accepted_states) ? args.accepted_states : null;
  if (accepted && accepted.length > 0) return accepted.includes(value);
  if (Array.isArray(args.required_states) && args.required_states.length > 0) {
    const state = typeof value === 'object' && !Array.isArray(value) ? value.visible_state ?? value.owner_state : value;
    return args.required_states.includes(state);
  }
  return true;
}

// Whether every fact the condition names has been looked up (signals.ownerReadbacks, by ref) and satisfies it.
export function readbackSatisfied(args, signals) {
  const readbacks = signals.ownerReadbacks;
  if (!readbacks) return false;
  const refs = [args.readback_ref, args.answer_fact_ref, args.objective_answer_ref].filter(ref => typeof ref === 'string' && ref.length > 0);
  return refs.length > 0 && refs.every(ref => readbackValueSatisfied(readbacks[ref], args));
}

// The ops a condition can name. A new op is one set(): `all-of` and `any-of` take any ops, so "answered and watched
// 90%" or "tapped or timed out" need no new code. Thresholds are in the condition's args, never here.
export function createAdvanceOps() {
  return new Map([
    ['tap-next', (_args, signals) => signals.nextTapped === true],
    ['target-interacted', (_args, signals) => signals.targetInteracted === true],
    ['answer-given', (_args, signals) => typeof signals.answer === 'string' && signals.answer.length > 0],
    ['media-watched', (args, signals) => finiteOr(signals.mediaRatio, 0) >= finiteOr(args.min_ratio, 1)],
    ['timeout', (args, signals) => finiteOr(signals.elapsedMs, 0) >= finiteOr(args.ms, 0)],
    ['surface-completed', (args, signals) => typeof args.completion_ref === 'string' && signals.surfaceCompletionRefs?.includes(args.completion_ref) === true],
    ['all-of', (args, signals, evaluate) => { const of = conditionsOf(args.of); return of.length > 0 && of.every(child => evaluate(child, signals)); }],
    ['any-of', (args, signals, evaluate) => conditionsOf(args.of).some(child => evaluate(child, signals))],
    ['owner-readback', readbackSatisfied],
  ]);
}

// Whether the step may move on by itself now. An op nobody defined holds the step where it is: a typo never pushes a
// person on, and the person can still move on by hand.
export function canAdvance(condition, signals, ops = createAdvanceOps()) {
  const evaluate = (child, childSignals) => (ops.get(child.op) ?? (() => false))(child.args ?? {}, childSignals, evaluate);
  return evaluate(condition, signals);
}

// ── Triggers ────────────────────────────────────────────────────────────────

// A trigger fires on one kind of event, and only when every field it names equals the event's.
export function eventMatchesTrigger(trigger, event) {
  if (trigger.on_event?.event_kind !== event.event_kind) return false;
  return Object.entries(trigger.on_event.match ?? {}).every(([key, expected]) => event[key] === expected);
}

// The key that, once recorded, stops a trigger firing again. With once_key_fields it is scoped by those event fields
// (so one person's tour being used up does not use up another's); null when the trigger has no key.
export function suppressionKeyForEvent(trigger, event) {
  if (trigger.once_key === undefined) return null;
  const fields = (trigger.once_key_fields ?? []).filter(field => field.trim().length > 0);
  if (fields.length === 0) return trigger.once_key;
  const scope = fields.map(field => {
    const value = event[field];
    const encoded = value === undefined || value === null ? '__missing__' : encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value));
    return `${encodeURIComponent(field)}=${encoded}`;
  });
  return `${trigger.once_key}::${scope.join('::')}`;
}

export function shouldFireTrigger(trigger, event, consumedKeys) {
  if (!eventMatchesTrigger(trigger, event)) return false;
  const key = suppressionKeyForEvent(trigger, event);
  return key === null || !consumedKeys.has(key);
}

// The first trigger, in the order written, that fires for the event; it comes back with its suppression key worked out
// for this event. Triggers are ordered by their author, so the order is the priority.
export function selectTrigger(triggers, event, consumedKeys = new Set()) {
  const selected = triggers.find(trigger => shouldFireTrigger(trigger, event, consumedKeys));
  if (!selected) return null;
  const key = suppressionKeyForEvent(selected, event);
  return key === selected.once_key ? selected : { ...selected, once_key: key ?? undefined };
}

// The event a Start or Replay control can send for one tour: the most specific repeatable trigger first, then the
// broader ones. Its match fields are copied in as they are.
export function startEventForTour(triggers, tourId) {
  const ranked = triggers
    .map((trigger, index) => {
      const match = trigger.on_event?.match ?? {};
      if (match.walkthrough_id !== undefined && match.walkthrough_id !== tourId) return null;
      return { trigger, index, rank: (trigger.once_key === undefined ? 0 : 2) + (match.walkthrough_id === tourId ? 0 : 1) };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const selected = ranked[0]?.trigger;
  return selected ? { event_kind: selected.on_event.event_kind, ...selected.on_event.match, walkthrough_id: tourId } : null;
}

// ── Tours as records ────────────────────────────────────────────────────────

const objectOf = value => {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
};

const isTour = row => row.kind === 'walkthrough-definition'
  && typeof row.id === 'string' && typeof row.entry_step === 'string'
  && Array.isArray(row.steps) && row.steps.every(step => step && typeof step.id === 'string');

// Tour records, given in the order they were written, folded into the tours now in force by id: a later record at an
// id replaces an earlier one and a record marked deleted removes it. Only what the engine reads is checked (id, entry
// step, step ids); every other field is carried as it came. Records that are not tours are skipped. The result is
// sorted by id so the same records always give the same answer.
export function foldTours(records) {
  const tours = new Map();
  for (const record of records) {
    const row = objectOf(record?.value_json ?? record?.payload ?? record);
    if (!row || typeof row.id !== 'string') continue;
    if (row.status === 'deleted') tours.delete(row.id);
    else if (isTour(row)) tours.set(row.id, { ...row, triggers: Array.isArray(row.triggers) ? row.triggers : [] });
  }
  return Object.fromEntries([...tours].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

// Which tour an event starts: the first tour, in id order, with a trigger that fires.
export function selectTourForEvent(tours, event, consumedKeys = new Set()) {
  for (const [id, tour] of Object.entries(tours)) {
    const trigger = selectTrigger(tour.triggers, event, consumedKeys);
    if (trigger) return { tourId: id, trigger };
  }
  return null;
}
