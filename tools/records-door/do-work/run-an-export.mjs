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
// A function a wake started may answer `wake_effects` (the engine's wake.json `effects_field`: timed runs, writes,
// events). The engine reads them from the top of the last line, so they are printed beside the result, not in it.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { openBearerDoor } from '../read-data/records-door.mjs';
import { valuesDoor } from '../read-data/values-door.mjs';

const EFFECTS = 'wake_effects';

// The host actions module loads at the first parent action a function uses, not when this command starts: a run that
// asks for none never loads it, so a row that packs only its own module still loads. The module reads the descriptor at
// its own first use, as before.
const parentActionsAtFirstUse = descriptor => new Proxy({}, { get: (_, method) => typeof method === 'string' ? async (...args) => {
  const { openHostActions } = await import('../../workflows/read-data/host-actions.mjs');
  return openHostActions({ descriptor }).parentActions[method](...args);
} : undefined });const [file, name, ...options] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-an-export.mjs <module file> <export name> < input.json');
  const parentActionsFd = options.length === 0 ? 3
    : options.length === 2 && options[0] === '--parent-actions-fd' && /^\d+$/.test(options[1]) ? Number(options[1]) : NaN;
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
  const answered = await fn(input, context);
  const keep = values.keep();
  const result = !keep.length ? answered
    : answered && typeof answered === 'object' && !Array.isArray(answered) ? { ...answered, keep: [...(answered.keep ?? []), ...keep] }
    : { answer: answered, keep };
  if (result && typeof result === 'object' && !Array.isArray(result) && EFFECTS in result) {
    const { [EFFECTS]: effects, ...shown } = result;
    console.log(JSON.stringify({ result: shown, [EFFECTS]: effects }));
  } else {
    console.log(JSON.stringify({ result }));
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
