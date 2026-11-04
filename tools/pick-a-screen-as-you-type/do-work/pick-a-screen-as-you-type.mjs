// tools/pick-a-screen-as-you-type/do-work/pick-a-screen-as-you-type.mjs
//
// Two tools run as functions (tools/records-door do-work/run-an-export.mjs), both by the moved modules unchanged and
// with no model:
//   pickAScreenForWords   tool:pick-a-screen-for-typed-words: the screen the typed words pick from the catalog handed
//                         in (offered screens, made interfaces by intent, kept screens by their words), ranked by
//                         src/instant-screens.mjs, and what to show after the calm rule (decide) given the last memory.
//   fillInputsFromWords   tool:fill-screen-inputs-from-words: a screen's inputs filled from the words by the one parser
//                         registry (src/input-parsers.mjs).
//
//   pickAScreenForWords({ words, rows?, made?, asks?, memory? }) -> { picks, memory }
//   fillInputsFromWords({ schema, words, now?, used?, choices? }) -> fillInputs' answer
import { fillInputs } from '../src/input-parsers.mjs';
import { catalogOf, decide, NO_PICK, rank } from '../src/instant-screens.mjs';

export function pickAScreenForWords(input = {}) {
  const { words = '', rows = [], made = [], asks = [], memory = NO_PICK } = input ?? {};
  const ranked = rank(catalogOf({ rows, made, asks }), words);
  return { picks: ranked.picks, memory: decide(memory ?? NO_PICK, ranked) };
}

export function fillInputsFromWords(input = {}) {
  const { schema, words = '', now, used = [], choices = {} } = input ?? {};
  if (!schema || typeof schema !== 'object') throw new Error('schema is the screen\'s input schema, { properties: { ... } }.');
  return fillInputs(schema, words, { now: now ? new Date(now) : new Date(), used, choices });
}
