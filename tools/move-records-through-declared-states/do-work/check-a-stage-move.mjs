// tools/move-records-through-declared-states/do-work/check-a-stage-move.mjs
//
// Where a record (a deal, an order, an applicant) is in its stages now, every move it could make and why each is or is
// not open, and, when a stage is asked for, whether it may move there and the move to keep. Run by the Workshop tool
// `tool:check-a-stage-move` in the tool container:
//
//   node do-work/check-a-stage-move.mjs < <the input as JSON>
//
// and prints { current_stage, options, requested? } as JSON on its last line. It keeps nothing: the caller keeps the
// returned move with the record, and the next call hands back the record's moves. A stage list that contradicts itself
// (a finished stage with a way out, a move naming a stage nobody declared) is refused with the reason.
import { text } from 'node:stream/consumers';
import { currentState, moveIsAllowed, moveRecordFor, movesAvailable, statesByKey, transitionsFrom } from './move-records-through-declared-states.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
const states = statesByKey(input.stages);
const transitions = transitionsFrom(input.transitions, states);
const from = currentState(input.moves, states, input.start);
const signals = input.signals ?? {};
const result = { current_stage: from, options: movesAvailable({ states, transitions, from, signals }) };
if (typeof input.to === 'string' && input.to) {
  const verdict = moveIsAllowed({ states, transitions, from, to: input.to, signals });
  result.requested = {
    to: input.to,
    ...verdict,
    move: verdict.allowed ? moveRecordFor({ states, transitions, from, to: input.to, signals, at: input.at ?? new Date().toISOString(), because: input.because ?? null }) : null,
  };
}
console.log(JSON.stringify(result));
