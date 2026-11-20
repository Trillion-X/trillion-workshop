// The package's five test "calls" (moved-from.json of the parked tours-screen/from-bitfield-packages) turned a real
// business's name, a once-key, a person's name, a tour id and a test variable into made-up ones, because a public tree
// holds made-up names only. They are checked here as outcomes: none of the five real forms is in this tool's files, or
// in the guided-overlay tool that mounts its tours. The real forms are put together from pieces, so this file is not
// itself a place they appear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const business = ['Eth', 'os'].join('');
const person = ['Br', 'ian'].join('');
const REAL = [
  ['a test tour title named a real business', new RegExp(`Welcome to ${business}`)],
  ['a test once-key named a real business', new RegExp(`${business.toLowerCase()}\\.roadmap-spotlight`)],
  ['a comment named a person', new RegExp(`${person} hit it repeatedly on the live web app\\.`)],
  ['a test tour id named a real business', new RegExp(`wt:${business.toLowerCase()}-first-tour`)],
  ['a test variable named a real business', new RegExp(`${business.toLowerCase()}Tour`)],
];

const filesUnder = folder => readdirSync(folder).flatMap(name => {
  const path = join(folder, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

for (const tool of ['tours-screen', 'guided-overlay']) {
  test(`${tool} holds none of the five real names the package's calls replaced`, () => {
    const files = filesUnder(new URL(`../../${tool}`, import.meta.url).pathname)
      .filter(path => !path.endsWith('/moved-from.json') && !path.includes('/ports/') && !/\.(webp|png|jpg|woff2?)$/.test(path));
    assert.ok(files.length > 10);
    const found = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const [what, pattern] of REAL) if (pattern.test(text)) found.push(`${path}: ${what}`);
    }
    assert.deepEqual(found, []);
  });
}
