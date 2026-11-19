// tools/fill-a-list-from-a-feed/do-work/run-given.mjs
//
// The one command the installed row runs: it imports the module the row names, calls the export the row names with the
// run's input (the caller's `stored` records included), and prints { result } (or { error }) as its last line. The run
// reads and writes no store: what it makes comes back in the result's `keep`, for the caller to keep.
//
//   node /opt/fill-a-list-from-a-feed/do-work/run-given.mjs /opt/fill-a-list-from-a-feed/read-data/list-feed.mjs fillAListFromFeed < input.json
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';

const [file, name] = process.argv.slice(2);
try {
  if (!file || !name) throw new Error('usage: run-given.mjs <module file> <export name> < input.json');
  const fn = (await import(pathToFileURL(file).href))[name];
  if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: await fn(input) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
