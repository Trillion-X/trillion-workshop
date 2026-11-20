// A program that runs its main part only when it is the one started (`node do-work/x.mjs`) compares import.meta.url
// with the path it was started by. import.meta.url is a URL: a space in its folder is %20, and the engine on a Mac runs
// a tool from a folder whose path holds a space (Application Support). A program that compares it with the plain path
// (`file://${process.argv[1]}`) never runs its main part there: it exits 0 and prints nothing, and the run answers
// "no $.result". So a program makes the path a URL first: pathToFileURL(realpathSync(process.argv[1])).href (or new
// URL(...)), the same on every computer.
// For the same reason a program never takes a file's path from a URL's `pathname` (`new URL('./x.js',
// import.meta.url).pathname`): that path keeps the %20, so the file it names is not found there. It uses
// fileURLToPath(new URL(...)). tool:list-running-programs failed every run on a Mac that way until Nov 19 2026: its
// reader read-programs.js was named by a path that did not exist, so workflow:stop-programs-left-running stopped there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = new URL('..', import.meta.url).pathname;
const BARE = /(?<!new URL\()`file:\/\/\$\{process\.argv\[1\]\}`/;

test('no program compares import.meta.url with its plain started path', () => {
  // git grep answers 1 when no file holds the words.
  let listed = '';
  try {
    listed = execFileSync('git', ['-C', repo, 'grep', '-lF', 'file://${process.argv[1]}', '--', 'tools', 'test-helpers'], { encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  // Only a file node runs: a kept old copy (.held) is never started.
  const holding = listed.split('\n').filter(path => /\.(mjs|js|cjs|ts)$/.test(path) && !path.includes('node_modules/'));
  const bare = holding.filter(path => BARE.test(readFileSync(repo + path, 'utf8')));
  assert.deepEqual(bare, [], `Compare import.meta.url with pathToFileURL(realpathSync(process.argv[1])).href in:\n${bare.join('\n')}`);
});

test('no program takes a file path from a URL pathname', () => {
  let listed = '';
  try {
    listed = execFileSync('git', ['-C', repo, 'grep', '-lF', 'import.meta.url).pathname', '--', 'tools', 'test-helpers'], { encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  // A test file runs from the checkout, never from the engine's folder; a kept old copy (.held) is never started.
  const programs = listed.split('\n').filter(path => /\.(mjs|js|cjs|ts)$/.test(path) && !path.includes('node_modules/')
    && !/(^|\/)(test|tests|__tests__|test-fixtures)\/|\.test\./.test(path));
  assert.deepEqual(programs, [], `Name the file with fileURLToPath(new URL(...)) in:\n${programs.join('\n')}`);
});
