// test/take-open-work-settings-names.test.mjs
//
// The tasks settings harness/take-open-work.mjs reads and the ones harness/take-open-work.json declares are the same names,
// both ways. It imports nothing from the program, so it still runs when a stale copy of the program changes its exports.
// Nov 22 2026, 5:5x AM CST: a whole-file landing of take-open-work.mjs from an older copy read tasks.take_unassigned while
// the JSON declared take_unassigned_when; the missing name read as undefined and the taker would have taken every
// unassigned task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };

test('every tasks setting take-open-work.mjs reads is declared in take-open-work.json, and every declared one is read', () => {
  const source = readFileSync(new URL('../harness/take-open-work.mjs', import.meta.url), 'utf8');
  // taskCaller holds settings.tasks as `rules`; that name means settings.tasks only inside its body.
  const start = source.indexOf('export function taskCaller');
  const end = source.indexOf('\nexport ', start + 1);
  assert.ok(start > 0 && end > start, 'taskCaller is found');
  const names = (text, pattern) => [...text.matchAll(pattern)].map(found => found[1]);
  const read = new Set([...names(source, /settings\.tasks\??\.(\w+)/g), ...names(source.slice(start, end), /\brules\.(\w+)/g)]);
  const declared = new Set(Object.keys(settingsFile.tasks).filter(name => name !== 'what_this_is'));
  assert.deepEqual([...read].filter(name => !declared.has(name)).sort(), [], 'read by the program but not declared in take-open-work.json tasks');
  assert.deepEqual([...declared].filter(name => !read.has(name)).sort(), [], 'declared in take-open-work.json tasks but read nowhere in take-open-work.mjs');
});
