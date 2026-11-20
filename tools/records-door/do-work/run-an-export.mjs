// tools/records-door/do-work/run-an-export.mjs
//
// The one command a Workshop row runs when its tool is a function: it imports the module the row names, calls the
// export the row names with the run's input, and prints { result } (or { error }) as its last line.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/<folder>/read-data/<file>.mjs <export>  < input.json
//
// The function is called as fn(input, { door, parentActions }). `door` answers the person's rows, settings and files from
// the values the caller gave in the input's `stored` (read-data/values-door.mjs): the engine keeps none of them, so the
// person's AI reads them from the person's own stores and hands them in. What the run writes comes back as the answer's
// `keep`, for the caller to keep there. Any other call (tools:run, sharing, wake) goes to the run's own door, which reads
// descriptor 3 on first use. `parentActions` reads the row's private action descriptor (3 by default, or the literal argv
// --parent-actions-fd N). The descriptor route carries no authority on its own: the native parent rechecks this run at
// the physical effect.
//
// A row that declares its keep table (argv: --keep-into TABLE --keep-fd N, the descriptor its connection is mounted on) writes
// its keep list there only when the run's input names a `database`: then the list is written in one transaction
// (write-keep-list.mjs) and the answer names the count. With no `database` the answer keeps the list, as every row does.
//
// A function a wake started may answer `wake_effects` (the engine's wake.json `effects_field`: timed runs, writes,
// events). The engine reads them from the top of the last line, so they are printed beside the result, not in it.
import { fstatSync, readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { openBearerDoor } from '../read-data/records-door.mjs';
import { valuesDoor } from '../read-data/values-door.mjs';
import { writeKeepList } from './write-keep-list.mjs';

const EFFECTS = 'wake_effects';

// The host actions module loads at the first parent action a function uses, not when this command starts: a run that
// asks for none never loads it, so a row that packs only its own module still loads. The module reads the descriptor at
// its own first use, as before.
const parentActionsAtFirstUse = descriptor => new Proxy({}, { get: (_, method) => typeof method === 'string' ? async (...args) => {
  const { openHostActions } = await import('../../workflows/read-data/host-actions.mjs');
  return openHostActions({ descriptor }).parentActions[method](...args);
} : undefined });// The keep list goes into the database on `fd`: the connection string is the held value the engine mounts there, never argv or a file.
// pg loads only here, on the write path, so a run without a database never loads it.
async function writeKeptRows(rows, table, fd) {
  fstatSync(fd); // refuses at once when nothing is mounted on the descriptor
  const connection = readFileSync(fd, 'utf8').trim();
  if (!/^postgres(ql)?:\/\//.test(connection)) throw new Error(`No database connection is mounted on descriptor ${fd}.`);
  const { default: pg } = await import('pg');
  const { throughProxy } = await import('../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs');
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return await writeKeepList(rows, client, { table });
  } finally {
    await client.end();
  }
}

const [file, name, ...options] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-an-export.mjs <module file> <export name> < input.json');
  const flags = new Map();
  for (let n = 0; n < options.length; n += 2) flags.set(options[n], options[n + 1]);
  if (options.length % 2 || [...flags.keys()].some(flag => !['--parent-actions-fd', '--keep-into', '--keep-fd'].includes(flag))) throw new Error('Supply --parent-actions-fd, or --keep-into with --keep-fd, with the row\'s declared file descriptors.');
  const parentActionsFd = !flags.has('--parent-actions-fd') ? 3
    : /^\d+$/.test(flags.get('--parent-actions-fd')) ? Number(flags.get('--parent-actions-fd')) : NaN;
  if (!Number.isSafeInteger(parentActionsFd) || parentActionsFd < 3) throw new Error('Supply --parent-actions-fd with the row\'s declared file descriptor.');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  // `stored` is in the run's input: at the top, or in the one field the row's stdin put the input in ({ input, task }).
  const given = JSON.parse((await text(process.stdin)) || '{}');
  const holder = given && typeof given === 'object' && !Array.isArray(given) && !('stored' in given)
    ? Object.keys(given).find(name => given[name] && typeof given[name] === 'object' && !Array.isArray(given[name]) && 'stored' in given[name]) : undefined;
  const { stored, ...input } = holder === undefined ? given
    : { stored: given[holder].stored, ...given, [holder]: Object.fromEntries(Object.entries(given[holder]).filter(([name]) => name !== 'stored')) };
  let own, parentActions;
  const values = valuesDoor(stored, { other: (...asked) => (own ??= openBearerDoor()).call(...asked) });
  const context = {
    door: values.door,
    get parentActions() { return (parentActions ??= parentActionsAtFirstUse(parentActionsFd)); },
  };
  // The database a keep list goes to is named in the input; the function never sees it.
  // Only a row that declares its keep table takes `database`; any other row passes its input on unchanged.
  const named = flags.has('--keep-into') && typeof input.database === 'string' && input.database.length > 0;
  const toFunction = named ? (({ database, ...rest }) => rest)(input) : input;
  const answered = await fn(toFunction, context);
  const keep = values.keep();
  if (named) {
    // The keep list goes into the row's table, one transaction; the answer then names the count, not the list.
    const keepFd = Number(flags.get('--keep-fd'));
    if (!Number.isSafeInteger(keepFd) || keepFd < 4) throw new Error('--keep-into needs --keep-fd with the descriptor its database is mounted on (not 3).');
    const object = answered && typeof answered === 'object' && !Array.isArray(answered);
    const { keep: returned = [], ...shown } = object ? answered : {};
    const written = await writeKeptRows([...(object ? returned : []), ...keep], flags.get('--keep-into'), keepFd);
    console.log(JSON.stringify({ result: { ...(object ? shown : { answer: answered }), kept_in: flags.get('--keep-into'), kept: written.written } }));
  } else {
    const result = !keep.length ? answered
      : answered && typeof answered === 'object' && !Array.isArray(answered) ? { ...answered, keep: [...(answered.keep ?? []), ...keep] }
      : { answer: answered, keep };
    if (result && typeof result === 'object' && !Array.isArray(result) && EFFECTS in result) {
      const { [EFFECTS]: effects, ...shown } = result;
      console.log(JSON.stringify({ result: shown, [EFFECTS]: effects }));
    } else {
      console.log(JSON.stringify({ result }));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
