// tools/records-door/do-work/run-an-export.mjs
//
// The one command a Workshop row runs when its tool is a function: it imports the module the row names, calls the
// export the row names with the run's input, and prints { result } (or { error }) as its last line.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/<folder>/read-data/<file>.mjs <export>  < input.json
//
// The function is called as fn(input, { door, parentActions }). Both open only on first use. `door` reads descriptor 3;
// `parentActions` reads the row's private action descriptor (3 by default, or the literal argv --parent-actions-fd N).
// The descriptor route carries no authority on its own: the native parent rechecks this run at the physical effect.
//
// A function a wake started may answer `wake_effects` (the engine's wake.json `effects_field`: timed runs, writes,
// events). The engine reads them from the top of the last line, so they are printed beside the result, not in it.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { openRecordsDoor, openParentActions } from '../read-data/records-door.mjs';

const EFFECTS = 'wake_effects';
const [file, name, ...options] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-an-export.mjs <module file> <export name> < input.json');
  const parentActionsFd = options.length === 0 ? 3
    : options.length === 2 && options[0] === '--parent-actions-fd' && /^\d+$/.test(options[1]) ? Number(options[1]) : NaN;
  if (!Number.isSafeInteger(parentActionsFd) || parentActionsFd < 3) throw new Error('Supply --parent-actions-fd with the row\'s declared file descriptor.');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  let door, parentActions;
  const context = {
    get door() { return (door ??= openRecordsDoor()); },
    get parentActions() { return (parentActions ??= openParentActions({ descriptor: parentActionsFd })); },
  };
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const result = await fn(input, context);
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
