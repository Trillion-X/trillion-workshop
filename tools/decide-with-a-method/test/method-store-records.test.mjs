// tool:read-a-method, fed from the old decision store: one method's steps and checks shaped into the records the reader takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAMethodFromStore, recordsOfMethod } from '../method-rows/store-records.mjs';

const HELPER = fileURLToPath(new URL('./read-method-store.py', import.meta.url));
const NEW_SCOPE_CHECKS = ['scope-aa-open-up-or-narrow-down', 'scope-nm-biggest-for-what', 'scope-nm-small-enough-to-win', 'scope-con-narrow-the-door-not-the-aim'];

test('a method shaped from its rows keeps its steps in order, each with the checks of that step, and reads as a view', () => {
  const methodRow = { id: 'record:method:tiny', name: 'Tiny', steps: JSON.stringify([{ id: 'scope', question: 'What is it?' }, { id: 'proof', question: 'Prove it?' }, { id: 'note' }]) };
  const check = (id, step) => ({ id, step, when: null, check: `${id}?`, good_answer: 'yes', source: { file: 'f', section: 's' } });
  const checklistRows = [
    { id: 'checklist:1f:b', checks: JSON.stringify([check('proof-a', 'proof'), check('scope-a', 'scope')]) },
    { id: 'checklist:1f:a', checks: JSON.stringify([check('scope-a', 'scope'), check('scope-b', 'scope')]) },
    { id: 'checklist:1f:c', checks: JSON.stringify([check('elsewhere', 'not-a-step')]) },
  ];
  const { view, records } = recordsOfMethod(methodRow, checklistRows);
  assert.equal(view, 'list-view:method-rows-tiny:tiny');
  const read = readAMethodFromStore({ methodRow, checklistRows });
  assert.equal(read.method, view);
  assert.equal(read.label, 'Tiny');
  assert.equal(read.of, 2, 'a step without a question is not a row of the view');
  assert.deepEqual(read.rows.map(row => row.values.id), ['scope', 'proof']);
  assert.deepEqual(read.rows[0].values.checks.map(c => c.id), ['scope-a', 'scope-b'], 'a check listed by two rows is kept once');
  assert.deepEqual(read.rows[1].values.checks.map(c => c.id), ['proof-a']);
  assert.equal(read.rows[0].strictness.from, 'default');
  assert.ok(records.every(record => 'value' in record && typeof record.id === 'string' && typeof record.type === 'string'));
});

test('universal, read from the old decision store: its scope step holds the checks added for scope', t => {
  const python = process.env.HELD_DATABASE_PYTHON;
  const lib = process.env.HELD_DATABASE_LIB;
  const connection = process.env.HELD_DATABASE_CONNECTION;
  if (!python || !lib || !connection) return t.skip('set HELD_DATABASE_PYTHON, HELD_DATABASE_LIB and HELD_DATABASE_CONNECTION (the held connection name)');
  // The checklist rows of a method are megabytes of checks: the child's output is not capped at spawnSync's default buffer.
  const read = spawnSync(python, ['-I', HELPER, lib, connection, 'record:method:universal'], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 * 1024 });
  if (read.status === 3) return t.skip(`held database unavailable: ${read.stderr.trim().split('\n').pop()}`);
  assert.equal(read.status, 0, read.stderr);
  const { method, checklist } = JSON.parse(read.stdout);
  const steps = JSON.parse(method.steps);
  // Each row carries its checks, so a page holds only the rows that fit its byte cap: follow `next` until the view is read.
  const first = readAMethodFromStore({ methodRow: method, checklistRows: checklist });
  assert.equal(first.label, 'Any decision');
  assert.equal(first.list, 'method-rows-universal');
  assert.equal(first.strictness.from, 'default');
  const rows = [];
  for (let page = first; ; page = readAMethodFromStore({ methodRow: method, checklistRows: checklist, after: page.next })) {
    rows.push(...page.rows);
    if (page.next === null) break;
  }
  const questioned = steps.filter(step => typeof step.question === 'string' && step.question.trim()).map(step => step.id);
  assert.equal(first.of, questioned.length);
  assert.deepEqual(rows.map(row => row.values.id), questioned, 'every step with a question, in the method order');
  for (const row of rows) {
    assert.ok(row.values.checks.every(check => check.step === row.values.id), `${row.id} holds only the checks of its step`);
  }
  const scope = rows.find(row => row.values.id === 'scope');
  for (const id of NEW_SCOPE_CHECKS) assert.ok(scope.values.checks.some(check => check.id === id), `${id} is on the scope step`);
});
