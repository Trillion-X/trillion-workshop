// tools/conversations/do-work/run-held.mjs
//
// The one command a Workshop row of this folder runs when its tool is a function, with the records the run needs handed in
// (read-data/held-door.mjs) rather than read through a door.
//
//   node /opt/conversations/do-work/run-held.mjs /opt/conversations/read-data/<file>.mjs <export>  < input.json
//
// stdin is the run's input, with the person's values in `stored` (at the top, or in the one field the row's stdin put the
// input in). The function is called as fn(input, { door }). The answer is printed as the last line: { result } where result
// is the function's answer with `keep` (what the run wrote, for the caller to keep in the person's own store), or, when the
// run needs records, lists or files it was not given, { result: { needs, keep: [], complete: false } }: the caller reads
// each need from its store, hands the answers in as stored, and runs again. Nothing is written by an incomplete run.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { heldDoor } from '../read-data/held-door.mjs';

/** The run's values and its input: `stored` is taken from the top of the input or from the field the row put it in. */
export function splitGiven(given) {
  const holder = given && typeof given === 'object' && !Array.isArray(given) && !('stored' in given)
    ? Object.keys(given).find(name => given[name] && typeof given[name] === 'object' && !Array.isArray(given[name]) && 'stored' in given[name]) : undefined;
  return holder === undefined ? (given ?? {}) : { stored: given[holder].stored, ...given, [holder]: Object.fromEntries(Object.entries(given[holder]).filter(([name]) => name !== 'stored')) };
}

/** Calls fn with the run's door and answers what it wrote, or what it still needs. */
export async function runHeld(fn, given) {
  const { stored = {}, ...input } = splitGiven(given);
  const held = heldDoor(stored);
  let answered;
  let failure = null;
  try { answered = await fn(input, { door: held.door }); } catch (error) { failure = error; }
  const needs = held.needs();
  if (needs.records.length || needs.lists.length || needs.files.length) {
    return { needs, keep: [], complete: false };
  }
  if (failure) throw failure;
  const keep = held.keep();
  if (!keep.length) return answered;
  return answered && typeof answered === 'object' && !Array.isArray(answered)
    ? { ...answered, keep, complete: true }
    : { answer: answered, keep, complete: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [file, name] = process.argv.slice(2);
  try {
    if (!file || !name) throw new Error('usage: run-held.mjs <module file> <export name> < input.json');
    const fn = (await import(pathToFileURL(file).href))[name];
    if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
    const given = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: await runHeld(fn, given) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
