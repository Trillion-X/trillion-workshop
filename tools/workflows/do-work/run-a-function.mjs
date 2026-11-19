// tools/workflows/do-work/run-a-function.mjs
//
// The command a row runs when its tool is a function of its input: it imports the module the row names, calls the export the
// row names with the run's input and prints { result } (or { error } with the error's own fields) as its last line. It reaches no
// database and no records door: a tool is given what it reads and answers what it makes, and the caller keeps it where the
// person keeps it. Its only reads of the computer are the host actions below. A host action (the native parent's Trash move, the run's by-name file read) is not a record: it is handed to the
// function as `host` (read-data/host-actions.mjs), read from the row's private descriptor (3 by default, or the literal argv
// --parent-actions-fd N) only when the function first uses it; the module itself is loaded then too (hostActions below).
//
// The function is called as fn(input, host). A function a wake started may answer `wake_effects` (the engine's
// wake.json `effects_field`: timed runs, writes, events); they are printed beside the result, not in it, where the engine
// reads them from the top of the last line.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';

const EFFECTS = 'wake_effects';
// The names openHostActions answers, so a function that lists its host sees them without loading anything.
const HOST_KEYS = ['files', 'run', 'operation', 'writeLarge', 'parentActions', 'readWholeFile'];
const [file, name, ...options] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-a-function.mjs <module file> <export name> [--parent-actions-fd N] < input.json');
  const parentActionsFd = options.length === 0 ? 3
    : options.length === 2 && options[0] === '--parent-actions-fd' && /^\d+$/.test(options[1]) ? Number(options[1]) : NaN;
  if (!Number.isSafeInteger(parentActionsFd) || parentActionsFd < 3) throw new Error('usage: run-a-function.mjs <module file> <export name> [--parent-actions-fd N] < input.json');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  const host = hostActions(parentActionsFd);
  const result = await fn(JSON.parse((await text(process.stdin)) || '{}'), host);
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
// for the line's own error, result or wake_effects. The host actions and any binary value (file content) are never printed.
function fieldsOf(error) {
  if (!error || typeof error !== 'object') return {};
  const fields = {};
  for (const [name, value] of Object.entries(error)) {
    if (['stack', 'cause', 'message', 'error', 'result', 'host', EFFECTS].includes(name) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    try { if (JSON.stringify(value) !== undefined) fields[name] = JSON.parse(JSON.stringify(value)); } catch { /* not plain JSON */ }
  }
  return fields;
}

// The host actions, loaded at the first use of one. host-actions.mjs and what it imports (whole-file.mjs, content-identity,
// the files tool's sender) are packed only by the rows whose function uses a host action, so loading it at start made every
// other row's run fail with "module not found" (Nov 19 2026: 83 of 87 rows). A function that uses none never loads it; one
// that does gets the real actions, or the load's own error if its row did not pack them.
function hostActions(descriptor) {
  let opened = null;
  const open = () => (opened ??= import('../read-data/host-actions.mjs').then(module => module.openHostActions({ descriptor })));
  const at = path => (...given) => open().then(actions => {
    const owner = path.slice(0, -1).reduce((value, key) => value[key], actions);
    return owner[path.at(-1)](...given);
  });
  const level = path => new Proxy(at(path), { get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : level([...path, key])) });
  // Only the host's own names answer: a function that reads another name from its second argument (a default such as
  // `{ env = process.env, fetchImpl = fetch } = {}`) gets undefined and keeps its default, as with a plain object.
  return new Proxy({}, {
    get: (_, key) => (HOST_KEYS.includes(key) ? level([key]) : undefined),
    has: (_, key) => HOST_KEYS.includes(key),
    ownKeys: () => HOST_KEYS, getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}
