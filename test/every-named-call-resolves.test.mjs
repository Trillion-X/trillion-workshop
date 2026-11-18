// Every call the shipped text names is one something answers (test-helpers/named-calls.mjs): a door operation the door
// lists (tools/tell-ais-how-to-act/door-calls.json), a tool or a workflow the Workshop has a row for. The names left
// behind by owners that moved are counted in test/named-calls-nothing-answers.json; the count may only go down. When it
// rises, the test names what the files changed since that count was written hold. The outcome is a count of 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { namedCallFindings } from '../test-helpers/named-calls.mjs';

const repo = new URL('..', import.meta.url).pathname;
const COUNT = 'test/named-calls-nothing-answers.json';
const ref = process.env.NAMED_CALLS_REF ?? 'HEAD';

test('the shipped text names no more calls nothing answers than it did', () => {
  const { total: allowed } = JSON.parse(execFileSync('git', ['-C', repo, 'show', `${ref}:${COUNT}`], { encoding: 'utf8' }));
  const { files, total } = namedCallFindings({ repo, ref });
  if (total <= allowed) return;
  const since = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H', ref, '--', COUNT], { encoding: 'utf8' }).trim();
  const changed = new Set(execFileSync('git', ['-C', repo, 'diff', '--name-only', since, ref], { encoding: 'utf8' }).split('\n'));
  const named = Object.entries(files).filter(([path]) => changed.has(path)).map(([path, names]) => `${path}: ${[...new Set(names)].join(', ')}`);
  assert.fail(`${total} calls nothing answers, ${allowed} allowed. In the files changed since the count was written:\n${named.join('\n')}\n\nName a tool or workflow by an id a row has, and a door call by a pair door-calls.json lists; the person's own data is in their own stores, never behind the door.`);
});

test('the door calls list names each method once, and each addressed one with its address', () => {
  const { calls, addressed = [] } = JSON.parse(readFileSync(new URL('../tools/tell-ais-how-to-act/door-calls.json', import.meta.url), 'utf8'));
  const methods = [...calls, ...addressed.map(([, method]) => method)];
  assert.equal(new Set(methods).size, methods.length);
  for (const method of calls) assert.match(method, /^[a-z][a-z-]*[:.][a-z][a-z_-]*$/);
  for (const [address, method] of addressed) assert.match(`${address} ${method}`, /^@[a-z][a-z0-9-]* [a-z][a-z-]*[:.][a-z][a-z_-]*$/);
});
