// tools/workflows/do-work/run-a-function.mjs
//
// The command a row runs when its tool is a function of its input alone, or of its input and the person's own files: it
// imports the module the row names, calls the export the row names with the run's input and prints { result } (or { error }) as
// its last line. It reaches no database and no records door; a tool that keeps rows uses run-with-sql.mjs instead.
//
//   node /opt/workflows/do-work/run-a-function.mjs /opt/<folder>/<file>.mjs <export> [--files-door-fd N]  < input.json
//
// The function is called as fn(input, { door }). `door` is there only when the row names a files descriptor (its `files`
// right, invoke.records.fd): it offers `files` and opens that descriptor on its first call, so a function that never reads a
// file opens nothing. A function a wake started may answer `wake_effects` (the engine's wake.json `effects_field`: timed runs,
// writes, events); they are printed beside the result, not in it, where the engine reads them from the top of the last line.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';

const EFFECTS = 'wake_effects';
const [file, name, ...options] = process.argv.slice(2);
try {
  const descriptor = options.length === 0 ? null
    : options.length === 2 && options[0] === '--files-door-fd' && /^\d+$/.test(options[1]) && Number(options[1]) >= 3 ? Number(options[1]) : NaN;
  if (!file || !name || Number.isNaN(descriptor)) throw new Error('usage: run-a-function.mjs <module file> <export name> [--files-door-fd N] < input.json');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  // The files door is read from the records-door package only by a row that declares a files right; a row with none packs this entry alone.
  let door;
  const open = async () => (door ??= (await import('../../records-door/read-data/records-door.mjs')).openRecordsDoor({ descriptor }));
  const context = { door: descriptor === null ? undefined : { files: async (...asked) => (await open()).files(...asked) } };
  const result = await fn(JSON.parse((await text(process.stdin)) || '{}'), context);
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
