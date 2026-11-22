// tools/show-where-each-phrase-came-from/do-work/show-where.mjs
//
// The computer tool `tool:show-where-each-phrase-came-from` (tool-rows.json): the provenance rows of one made piece, answered as
// { piece_id, columns, rows, row_count }. The rows are read from public.piece_provenance by tool:run-sql-in-my-database, run on this
// computer's own door with the held connection name the person gave as credential_name. This process never holds a connection
// string: the name is passed on, and the database login stays in the vault.
//
// Input (JSON on stdin): { piece, credential_name }
//   piece            the piece id as piece_provenance keeps it (piece_id), a name of 1 to 200 letters, digits, colons, dots, underscores or dashes
//   credential_name  the held name of the database connection (a login that may read)
//
// Key Concepts: the door client is use-your-tools-from-a-shell's engineClient; opWhole answers a tool run whole, as make-a-login does.
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFor, doorFor, speakAsInstalledSite, engineClient, opWhole, CommandError } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const say = (message, status) => new CommandError(message, { status });

const NAME = /^[A-Za-z0-9:._-]{1,200}$/;
const HELD = /^[a-z0-9][a-z0-9_-]{0,120}$/;
export const PROVENANCE_SQL = 'SELECT piece_id, span, library_table, library_row_id, quote, at, recorded_at FROM public.piece_provenance WHERE piece_id = $1 ORDER BY span, recorded_at, at';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Checks the input before any call is made; answers the piece and the held name. */
export function inputOf(given) {
  if (!plain(given)) throw say('The input must be { piece, credential_name }.', 2);
  if (typeof given.piece !== 'string' || !NAME.test(given.piece)) throw say('piece must be the piece id: 1 to 200 letters, digits, colons, dots, underscores or dashes.', 2);
  if (typeof given.credential_name !== 'string' || !HELD.test(given.credential_name)) throw say('credential_name must be the held name of a database connection.', 2);
  return { piece: given.piece, credential_name: given.credential_name };
}

/** One read of the piece's rows, through the run-sql tool on this computer's door; answers { piece_id, columns, rows, row_count }. */
export async function showWhere({ input, runTool }) {
  const { piece, credential_name } = inputOf(input);
  const asked = await runTool('tool:run-sql-in-my-database', { credential_name, sql: PROVENANCE_SQL, params: [piece] });
  if (asked?.exit_code !== 0) throw say(`The provenance rows could not be read: ${asked?.error ?? 'no answer'}.`, 3);
  const { columns, rows, row_count: rowCount } = asked.result;
  return { piece_id: piece, columns, rows, row_count: rowCount };
}

/** Runs one tool on this computer's own door and answers its whole answer. */
const runToolOn = client => (tool, input) => opWhole(client, null, 'tools:run', { tool, input }, { requestKey: randomUUID(), route: {} });

async function main(stdin = process.stdin, print = line => process.stdout.write(`${line}\n`)) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  speakAsInstalledSite();
  const credential = await credentialFor();
  const client = engineClient({ door: doorFor({ credential }), credential });
  print(JSON.stringify(await showWhere({ input, runTool: runToolOn(client) })));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status ?? 1;
  });
}
