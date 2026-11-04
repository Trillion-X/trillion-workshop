// tools/stream-an-answer-in-keyed-parts/do-work/stream-an-answer-in-keyed-parts.mjs
//
// tool:merge-a-streamed-answer, run as a function (tools/records-door do-work/run-an-export.mjs): merges the events of
// a streamed answer into its entry by src/keyed-parts.mjs unchanged (text appends, sources and related questions are
// parts of their own, a patch changes a part already sent, a snapshot re-attaches, a replay adds nothing twice), and
// answers the entry with the token a re-attach continues from.
//
//   mergeAStreamedAnswer(input) -> { entry, resume }
//   input: { events: [event], entry?: an entry an earlier call answered }
import { mergeEvent, newEntry, resumeToken } from '../src/keyed-parts.mjs';

export function mergeAStreamedAnswer(input = {}) {
  const { events = [], entry: held } = input ?? {};
  if (!Array.isArray(events)) throw new Error('events is a list of the stream\'s events, each { seq, type, ... }.');
  const entry = events.reduce((current, event) => mergeEvent(current, event), held ?? newEntry());
  return { entry, resume: resumeToken(entry) };
}
