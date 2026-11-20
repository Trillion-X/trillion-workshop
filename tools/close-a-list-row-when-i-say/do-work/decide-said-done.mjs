// tools/close-a-list-row-when-i-say/do-work/decide-said-done.mjs
//
// The command of tool:decide-what-a-said-done-answer-means. One JSON input (argv[2]):
//   { ask: <one item of tool:name-the-open-rows-a-message-names' asks>, probability: number | null, message: { id, ... } }
// probability is the classifier's 0 to 1 yes, or null when no computer answered. Prints one JSON line:
//   { verdict, probability?, settle? }   a clear yes: settle the row through the lists road
//   { verdict: 'not_said', probability } a clear no: nothing happens
//   { verdict: 'unsure' | 'no_classifier', probability?, hand }  the judgement goes to the person's AIs, once per message and row
// Settling and the hand-off are the next steps' tools; this one only says what the answer means.
import { saidDoneVerdict } from '../src/said-done.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function decideSaidDone(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Give { ask, probability, message } as one object.');
  if (!input.ask || typeof input.ask !== 'object') throw new Error('ask must be one item from the name step.');
  const { probability } = input;
  if (probability !== null && (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)) {
    throw new Error('probability must be a number from 0 to 1, or null when no computer answered.');
  }
  return saidDoneVerdict({ ask: input.ask, probability, message: input.message ?? {} });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify(decideSaidDone(JSON.parse(process.argv[2] ?? '{}')))}\n`);
}
