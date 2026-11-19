// tools/workflows/do-work/run-a-function.mjs
//
// The command a row runs when its tool is a function of its input: it imports the module the row names, calls the export the
// row names with the run's input and prints { result } (or { error } with the error's own fields) as its last line. It
// reaches no database, no records door and no files: a tool is given what it reads and answers what it makes, and the
// caller keeps it where the person keeps it.
//
//   node /opt/workflows/do-work/run-a-function.mjs /opt/<folder>/<file>.mjs <export>  < input.json
//
// The function is called as fn(input). A function a wake started may answer `wake_effects` (the engine's wake.json
// `effects_field`: timed runs, writes, events); they are printed beside the result, not in it, where the engine reads them
// from the top of the last line.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';

const EFFECTS = 'wake_effects';
const [file, name, ...extra] = process.argv.slice(2);
try {
  if (!file || !name || extra.length) throw new Error('usage: run-a-function.mjs <module file> <export name> < input.json');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  const result = await fn(JSON.parse((await text(process.stdin)) || '{}'));
  if (result && typeof result === 'object' && !Array.isArray(result) && EFFECTS in result) {
    const { [EFFECTS]: effects, ...shown } = result;
    console.log(JSON.stringify({ result: shown, [EFFECTS]: effects }));
  } else {
    console.log(JSON.stringify({ result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ...fieldsOf(error), error: error?.message ?? String(error) }));
  process.exitCode = 1;
}

// The fields a function put on its error (not_sent, code and the like), printed beside its message so a caller can act on
// them. The stack and the cause are never printed, a field that is not plain JSON is left out, and no field may stand in
// for the line's own error, result or wake_effects.
function fieldsOf(error) {
  if (!error || typeof error !== 'object') return {};
  const fields = {};
  for (const [name, value] of Object.entries(error)) {
    if (['stack', 'cause', 'message', 'error', 'result', EFFECTS].includes(name)) continue;
    try { if (JSON.stringify(value) !== undefined) fields[name] = JSON.parse(JSON.stringify(value)); } catch { /* not plain JSON */ }
  }
  return fields;
}
