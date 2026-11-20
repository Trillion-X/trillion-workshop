// tools/name-voices-from-the-call/do-work/guess-voice-suggestions.mjs
//
// The command of tool:guess-voice-suggestions. One JSON input (argv[2]). The caller reads the rows and the evidence (the
// person's rows, the calendar, the recording titles and file names, the names said nearby, the earlier choices) and hands
// them in as data; this command builds the read guessVoices (read-data/guess-voices.mjs) expects from them, runs it, and
// prints one JSON line: { voices: [{ id, speaker, suggestions: [{ id?, list_id?, title, why, sure }], why, also? }], why?, left_out }.
// The card on the Waiting on you screen reads voices[].suggestions[0] as box.suggestions. A suggestion names nothing: the
// person picks, and a suggestion with `sure` may be preselected only (guess-voices invariant 2 and 9).
import { guessVoices } from '../read-data/guess-voices.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function guessVoiceSuggestions(input) {
  if (!object(input)) throw new Error('Give { voices, people, rules, pattern, owner, ... } as one object.');
  for (const name of ['voices', 'people']) if (!Array.isArray(input[name])) throw new Error(`${name} must be a list.`);
  if (!object(input.rules)) throw new Error('rules must be the DATA rules (sources.voices.guess of waiting-on-you.json).');
  if (typeof input.pattern !== 'string' || !input.pattern) throw new Error('pattern must be the listener-guess pattern from the DATA.');
  const pick = (table, key) => (object(table) && key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined);
  const read = {
    owner: input.owner ?? '',
    ownerWords: () => (Array.isArray(input.owner_words) ? input.owner_words : []),
    calendar: async () => ({ items: Array.isArray(input.calendar_items) ? input.calendar_items : [] }),
    title: clip => pick(input.titles, clip) ?? null,
    names: clip => (Array.isArray(pick(input.names, clip)) ? pick(input.names, clip) : []),
    earlier: ({ app, speaker }) => pick(input.earlier, `${app}|${speaker}`) ?? null,
    said: ({ conversation_id: conversation }) => {
      const messages = pick(input.said, conversation);
      return Array.isArray(messages) ? messages : [];
    },
  };
  const answer = await guessVoices({ voices: input.voices, rules: input.rules, pattern: input.pattern, people: input.people, read });
  return answer;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify(await guessVoiceSuggestions(JSON.parse(process.argv[2] ?? '{}')))}\n`);
}
