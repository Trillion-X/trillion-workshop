// tools/guided-tours/do-work/tours.mjs
//
// The command of the four tour tools. The verb is the first argument and one JSON request is on standard input:
//   step         { tour, action, cursor?, answer?, step_id? }  -> { cursor, step, finished }
//   may-advance  { condition, signals }                         -> { may_advance }
//   find         { tours, event, consumed_keys? }               -> { tour_id, trigger, suppression_key }
//   start-event  { tours, tour_id }                             -> { event }
// and one JSON line out: { result }, or { error } with a non-zero exit when the request cannot be read. Nothing is kept
// between calls: the caller holds the cursor and the suppression keys it has recorded.
import { text as readStdin } from 'node:stream/consumers';
import {
  advance, canAdvance, currentStep, foldTours, jump, restart, retreat, selectTourForEvent, startEventForTour,
  startTour,
} from './tour.mjs';

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function readTour(value) {
  if (!isObject(value) || typeof value.entry_step !== 'string' || !Array.isArray(value.steps)
    || !value.steps.every(step => isObject(step) && typeof step.id === 'string')) {
    throw new Error('tour must be the tour record: an object with entry_step (text) and steps (a list of objects with an id).');
  }
  if (!value.steps.some(step => step.id === value.entry_step)) throw new Error(`tour has no step ${value.entry_step}, which is its entry_step.`);
  return value;
}

function readCursor(value) {
  if (!isObject(value) || typeof value.current_step_id !== 'string' || !['active', 'complete'].includes(value.status)
    || !Array.isArray(value.history) || !value.history.every(id => typeof id === 'string')) {
    throw new Error('cursor must be the one this tool returned: { current_step_id, history, status }.');
  }
  return { currentStepId: value.current_step_id, history: value.history, status: value.status };
}

const cursorOut = cursor => ({ current_step_id: cursor.currentStepId, history: cursor.history, status: cursor.status });

const readTours = value => {
  if (!Array.isArray(value)) throw new Error('tours must be the list of tour records, in the order they were written.');
  return foldTours(value);
};

const readEvent = value => {
  if (!isObject(value) || typeof value.event_kind !== 'string') throw new Error('event must be an object with an event_kind.');
  return value;
};

const actions = {
  start: tour => startTour(tour),
  restart: tour => restart(tour),
  advance: (tour, cursor, input) => advance(tour, cursor, input.answer),
  back: (_tour, cursor) => retreat(cursor),
  jump: (tour, cursor, input) => {
    if (typeof input.step_id !== 'string') throw new Error('jump needs step_id, the step to go to.');
    return jump(tour, cursor, input.step_id);
  },
};

const verbs = {
  step(input) {
    const tour = readTour(input.tour);
    if (!Object.hasOwn(actions, input.action)) throw new Error(`action must be start, restart, advance, back or jump, not ${input.action}.`);
    const needsCursor = !['start', 'restart'].includes(input.action);
    if (needsCursor && input.cursor === undefined) throw new Error(`${input.action} needs the cursor from the last answer.`);
    const cursor = actions[input.action](tour, needsCursor ? readCursor(input.cursor) : undefined, input);
    return { cursor: cursorOut(cursor), step: currentStep(tour, cursor), finished: cursor.status === 'complete' };
  },
  'may-advance'(input) {
    if (!isObject(input.condition) || typeof input.condition.op !== 'string') throw new Error('condition must be an object with an op.');
    const s = input.signals ?? {};
    return {
      may_advance: canAdvance(input.condition, {
        nextTapped: s.next_tapped, targetInteracted: s.target_interacted, answer: s.answer, mediaRatio: s.media_ratio,
        elapsedMs: s.elapsed_ms, surfaceCompletionRefs: s.surface_completion_refs, ownerReadbacks: s.owner_readbacks,
      }),
    };
  },
  find(input) {
    const event = readEvent(input.event);
    const hit = selectTourForEvent(readTours(input.tours), event, new Set(input.consumed_keys ?? []));
    return hit
      ? { tour_id: hit.tourId, trigger: hit.trigger, suppression_key: hit.trigger.once_key ?? null }
      : { tour_id: null, trigger: null, suppression_key: null };
  },
  'start-event'(input) {
    if (typeof input.tour_id !== 'string') throw new Error('tour_id must be the id of the tour to start.');
    const tour = readTours(input.tours)[input.tour_id];
    if (!tour) throw new Error(`no tour ${input.tour_id} among the tours given.`);
    return { event: startEventForTour(tour.triggers, input.tour_id) };
  },
};

export const runVerb = (verb, input) => {
  if (!Object.hasOwn(verbs, verb)) throw new Error(`unknown tour command ${verb}: use step, may-advance, find or start-event.`);
  return verbs[verb](input ?? {});
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: runVerb(process.argv[2], JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
