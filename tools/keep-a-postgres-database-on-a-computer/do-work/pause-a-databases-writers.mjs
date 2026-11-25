// tools/keep-a-postgres-database-on-a-computer/do-work/pause-a-databases-writers.mjs
//
// Pauses, and resumes, the programs that write a database while it moves to another server, from the move's own pointers row:
// its `check_result.pause` names the old server's computer row and PostgreSQL unit and holds the statements, `run` (take each
// writer's right to connect, end its sessions) and `reverse` (give the rights back), in the server's own SQL, written there
// before anything runs. This program only builds the apply request (stdout) that puts one of the two lists on the server's row
// as a file its unit runs with psql as the server's own account (a `then`, so PostgreSQL keeps running): `pause` writes `run`,
// `resume` writes `reverse` over it. start-a-computer applies it like any other row change; nothing is typed on the server.
// The journal gets one line, tagged pause-a-databases-writers, the moment the statements have run: that is paused_at.
//
// usage: node pause-a-databases-writers.mjs pause|resume RUNS_JSON POINTER_JSON WORKSHOP_COMMIT > request.json
//   RUNS_JSON     the old server's computer row `runs`, as read from the database now (`select runs from computer where name = ...`)
//   POINTER_JSON  the move's pointers row (its `id` and `check_result`), as read from the database now
//
// Why (Nov 25 2026): a moving database's writers were paused by statements typed as the server's own account over SSH; the
// statements were on the pointers row, but nothing ran them from it, and nothing recorded when they ran.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const refused = message => Object.assign(new Error(message), { exit: 2 });
const words = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);

/** The statements one phase writes: a list of SQL statements, each one statement with no psql command (a line that starts with a
 * backslash would let the file run a shell command as the server's own account) and no terminator of its own. */
function statementsOf(list, where) {
  if (!Array.isArray(list) || list.length === 0) throw refused(`${where} is a list of SQL statements, at least one.`);
  return list.map((statement, i) => {
    const text = typeof statement === 'string' ? statement.trim().replace(/;$/, '') : '';
    if (!text) throw refused(`${where}[${i}] is an empty statement.`);
    if (/(^|\n)\s*\\/.test(text) || text.includes(';')) throw refused(`${where}[${i}] is more than one SQL statement, or a psql command.`);
    return text;
  });
}

/** The apply request that writes one phase's statements on the old server's row. */
export function pauseRequest({ phase, runs, pointer, commit }) {
  if (!['pause', 'resume'].includes(phase)) throw refused('The phase is pause or resume.');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw refused('The Workshop commit is a full commit id.');
  const id = String(pointer?.id ?? '');
  if (!/^pointer:[a-z0-9-]+$/.test(id)) throw refused('The pointers row needs its id, pointer: and words joined by dashes.');
  const result = typeof pointer.check_result === 'string' ? JSON.parse(pointer.check_result) : pointer.check_result;
  const pause = result?.pause;
  if (!pause || !words(pause.computer) || !words(pause.unit)) throw refused(`${id} needs check_result.pause with the old server's computer and its PostgreSQL unit.`);
  const run = statementsOf(pause.run, `${id} check_result.pause.run`);
  const reverse = statementsOf(pause.reverse, `${id} check_result.pause.reverse`);
  const unit = (runs?.units ?? []).find(row => row.unit === pause.unit);
  if (!unit) throw refused(`The computer row of ${pause.computer} runs no ${pause.unit}.`);
  const home = unit.hba_file ?? unit.settings_file;
  const socket = (unit.environment ?? []).find(line => line.startsWith('PGHOST='))?.slice('PGHOST='.length);
  if (!home || !socket || !words(unit.user)) throw refused(`${pause.unit} needs its hba_file or settings_file, its user and PGHOST in its environment.`);
  const path = `${dirname(home)}/writes-paused-${id.slice('pointer:'.length)}.sql`;
  const statements = phase === 'pause' ? run : reverse;
  const text = `-- Written from this computer's row by pause-a-databases-writers (${phase}), from ${id}; run once each time it changes.\n`
    + statements.map(statement => `${statement};\n`).join('');
  const then = [['sh', '-c', `runuser -u ${unit.user} -- psql -X -q -v ON_ERROR_STOP=1 -h ${socket} -d postgres < ${path} && logger -t pause-a-databases-writers '${phase} ${id}'`]];
  const files = unit.files ?? [];
  const to = [...files.filter(file => file.path !== path), { path, text, then }];
  const edits = [{ at: `runs.units[unit=${pause.unit}].files`, from: files, to }];
  if ((runs.absent ?? []).includes(path)) edits.push({ at: 'runs.absent', from: runs.absent, to: runs.absent.filter(gone => gone !== path) });
  return { computer: pause.computer, workshop_commit: commit, edits };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [phase, runsFile, pointerFile, commit] = process.argv.slice(2);
  try {
    const read = file => JSON.parse(readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(pauseRequest({ phase, runs: read(runsFile), pointer: read(pointerFile), commit }), null, 1)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(error.exit ?? 1); }
}
