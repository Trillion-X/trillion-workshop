// tools/close-a-list-row-when-i-say/do-work/name-the-open-rows.mjs
//
// The command of tool:name-the-open-rows-a-message-names. One JSON input (argv[2]):
//   { message: { id, app, text, speaker, origin?, conversation_id?, at?, about? }, rows: [{ record_id, row_id, list, field, values, mention? }],
//     names: { finish }, brought_in?: boolean }
// The caller reads the open rows the message names (the rows read from their store) and says whether the words are history brought in.
// Prints one JSON line: { asks: [{ record_id, row_id, list_id, title, question: { state, questions }, values, filled }] }. An empty
// list when the words are not the person's own, or are history brought in. The question is asked by the next step, never here.
import { saidDoneAsks } from '../src/said-done.mjs';
import { realpathSync } from 'node:fs';

export function nameTheOpenRows(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Give { message, rows, names } as one object.');
  if (!Array.isArray(input.rows)) throw new Error('rows must be a list of the open rows the message names.');
  if (input.brought_in !== undefined && typeof input.brought_in !== 'boolean') throw new Error('brought_in must be true or false.');
  return { asks: saidDoneAsks({ message: input.message, rows: input.rows, names: input.names, broughtIn: () => input.brought_in === true }) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  process.stdout.write(`${JSON.stringify(nameTheOpenRows(JSON.parse(process.argv[2] ?? '{}')))}\n`);
}
