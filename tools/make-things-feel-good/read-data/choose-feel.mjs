// parts/feel/read-data/choose-feel.mjs
//
// Purpose
//   Decides how one thing that happened feels: which moment row answers the event, and for each output (touch, sound,
//   motion, any later one) what plays, after the person's show rules have had their say. Pure: no DOM, no clock, no
//   storage; the page's player (show/mount-feel.ts), the Feel settings and the tests call it the same way.
//
// Non-negotiable invariants
//   1. Nothing here names an event, a moment, a feel or an output: rows answer events the way delight moments do
//      (parts/delight-moments rowAnswers), the outputs and feels are the DATA's (records/feel-moments.json).
//   2. Each output is its own thing to the rules: { moment, event_kind, feel, output }. A rule that changes things
//      (show rules `set`) may give it another feel, and a hidden or silenced output plays nothing; so the person can
//      keep the touch of a moment and quiet its sound, or give one moment another feel on one device only.
//   3. A feel that has nothing for an output plays nothing there; an unknown feel plays nothing anywhere.
//   4. The same feel does not play twice within the DATA's `repeat_gap_ms` (a button's own done and the command's done
//      are one moment to the person): `played` is what played last, by feel, and the answer says what to remember.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { rowAnswers } from '../../delight-moments/read-data/choose-moment.mjs';

/** The first moment row that answers `event`, or null. */
export function momentFor(data, event) {
  return (data?.moments ?? []).find(row => rowAnswers(row, event)) ?? null;
}

/** What each output plays for `momentRow` with feel `feelId`. `rules` is { changed(subject, thing), showOf(subject,
 *  thing) } (the page's show rules; tests pass their own). Returns [{ output, feel, play }], only outputs that play. */
export function feelOutputs(data, momentRow, feelId, rules, eventKind = '') {
  const plays = [];
  for (const output of data?.outputs ?? []) {
    const asked = { moment: momentRow.id, event_kind: eventKind, feel: feelId, output: output.id };
    const thing = rules?.changed ? rules.changed('feel', asked) : asked;
    const answer = rules?.showOf ? rules.showOf('feel', thing) : { hidden: false, silenced: false };
    if (answer.hidden || answer.silenced) continue;
    const feel = typeof thing.feel === 'string' ? thing.feel : feelId;
    const play = data.feels?.[feel]?.[output.id];
    if (play) plays.push({ output: output.id, feel, play });
  }
  return plays;
}

/**
 * Everything that plays for one happened event: { moment, plays, remember }. `played` maps a feel id to the time it
 * last played; a feel played within `repeat_gap_ms` of `now` is left out (invariant 4).
 */
export function chooseFeel(data, event, rules, { now = 0, played = {} } = {}) {
  const moment = momentFor(data, event);
  if (!moment || !data.feels?.[moment.feel]) return { moment: null, plays: [], remember: played };
  const gap = Number(data.repeat_gap_ms ?? 0);
  const plays = feelOutputs(data, moment, moment.feel, rules, event.event_kind)
    .filter(one => !(gap > 0 && Number.isFinite(played[one.feel]) && now - played[one.feel] < gap));
  const remember = { ...played };
  for (const one of plays) remember[one.feel] = now;
  return { moment, plays, remember };
}

/** Every event kind some feel row answers, so the coverage judge (scripts/check-delight.mjs) counts them answered. */
export const feltKinds = data => new Set((data?.moments ?? []).map(row => row.on?.event_kind).filter(kind => typeof kind === 'string'));
