// Home's answers from the person's own rows: each owner row becomes the part's shape, and an incomplete row is left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalsOf, isMissingTable, openWorkOf, rolesOf, waitingOf } from '../read-data/home-answers.mjs';
import sources from '../read-data/home-sources.json' with { type: 'json' };

test('the role map keeps only the connection names of the roles Home reads', () => {
  assert.deepEqual(rolesOf('{"roles":{"notices":{"credential_name":"own-a-connection","table":"notices"},"goals":{"credential_name":"own-a-connection","table":"home_goals"},"open_work":{"credential_name":"a-login-name","table":"job_runs"},"contacts":{"credential_name":"x-connection","table":"t"}}}'), { notices: 'own-a-connection', goals: 'own-a-connection' });
  assert.deepEqual(rolesOf(null), {});
  assert.deepEqual(rolesOf('not json'), {});
});

test('an unread needs-you notice is a waiting row, its body as the detail', () => {
  assert.deepEqual(waitingOf([{ id: '366', title: 'tool stopped', body: null, made_at: '2026-11-21T10:37:16.101Z' }]), [{ id: '366', title: 'tool stopped', detail: null }]);
});

test('open work is one started job, its start as handed_at', () => {
  assert.deepEqual(openWorkOf([{ id: 'r1', job: 'write-article', trigger: 'request', started_at: '2026-11-20T10:00:00.000Z' }], 'started'), [
    { handoff_id: 'r1', status: 'started', job: 'write-article', said: null, in_the_way: null, parent_handoff_id: null, handed_at: '2026-11-20T10:00:00.000Z', finished_at: null },
  ]);
});

test('a goal keeps its needle-mover mark from its own column and no link it does not hold', () => {
  assert.deepEqual(goalsOf([{ id: 'g1', title: 'Grow', now_text: '1,200', after_text: null, why_it_matters: null, needle_mover: true }]), [
    { id: 'g1', title: 'Grow', now: '1,200', after: undefined, why_it_matters: undefined, needle_mover: true },
  ]);
});

test('a missing table is the one error that means no goals yet', () => {
  assert.equal(isMissingTable('ERROR 42P01: relation "home_goals" does not exist'), true);
  assert.equal(isMissingTable('relation "home_goals" does not exist'), true);
  assert.equal(isMissingTable('connection refused'), false);
});

test('every read names a credential and a statement with one row-limit parameter', () => {
  for (const key of ['notices', 'open_work']) assert.match(sources[key].sql, /limit \$1$/);
  assert.match(sources.roles_sql, /\$1$/);
});
