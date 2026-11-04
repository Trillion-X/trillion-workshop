// tools/make-things-feel-good/do-work/pick-a-moment.mjs
//
// The small good moment to play for one thing that happened, or for a phrase typed: the delight moments' own pick
// (read-data/choose-moment.mjs `chooseMoment` and `typedMoment`) run once over moment rows the caller gives. A row
// answers by its event kind and fields, or by the phrase the typed text ends with; once-only rows play once, count_at
// rows only at those counts, and a row's words rotate by how many times it has played. The answer says what to remember
// so the next pick is right. Nothing is played, shown, stored or sent, and no clock is read: the caller keeps memory and
// gives it back next time.
//
// Input:  { moments, event?, typed?, memory? }
//           moments: the moment rows ([{ id, on: { event_kind, match?, starts_with? } | { typed }, words, motion?,
//                    mark?, once?, count_at? }]), tried in order;
//           event: what happened ({ event_kind, ...fields }), or typed: the text typed so far (give exactly one);
//           memory: the remember of the last pick ({ counts, played }); left out the first time.
// Answer: { moment: { id, motion, mark, words } | null, remember: { counts, played } }
// Refuses: moments that are not a list of rows each with an id, neither or both of event and typed, an event without
//          an event_kind, or memory that is not an object.
import { chooseMoment, typedMoment } from '../read-data/choose-moment.mjs';

export function pickAMoment({ moments, event, typed, memory } = {}) {
  if (!Array.isArray(moments) || !moments.every(row => row && typeof row === 'object' && typeof row.id === 'string' && row.id)) {
    throw new Error('Give moments: a list of moment rows, each { id, on: { event_kind } or { typed }, words }.');
  }
  if ((event === undefined) === (typed === undefined)) throw new Error('Give exactly one of event (what happened, { event_kind, ... }) and typed (the text typed so far).');
  if (memory !== undefined && (!memory || typeof memory !== 'object' || Array.isArray(memory))) throw new Error('memory is the remember of the last pick ({ counts, played }); leave it out the first time.');
  if (typed !== undefined) {
    if (typeof typed !== 'string') throw new Error('typed is the text typed so far, as text.');
    return typedMoment(moments, typed, memory);
  }
  if (!event || typeof event !== 'object' || typeof event.event_kind !== 'string' || !event.event_kind) throw new Error('event needs event_kind: what kind of thing happened, as text, such as "tour.finished".');
  return chooseMoment(moments, event, memory);
}
