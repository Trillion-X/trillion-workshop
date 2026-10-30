// tools/records-door/do-work/run-an-export.mjs
//
// The one command a Workshop row runs when its tool is a function: it imports the module the row names, calls the
// export the row names with the run's input, and prints { result } (or { error }) as its last line.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/<folder>/read-data/<file>.mjs <export>  < input.json
//
// The function is called as fn(input, { door }). `door` is the person's records door (read-data/records-door.mjs),
// opened on first use from descriptor 3, so a function that never reads records never needs one.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { openRecordsDoor } from '../read-data/records-door.mjs';

const [file, name] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-an-export.mjs <module file> <export name> < input.json');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  let door;
  const context = { get door() { return (door ??= openRecordsDoor()); } };
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: await fn(input, context) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
