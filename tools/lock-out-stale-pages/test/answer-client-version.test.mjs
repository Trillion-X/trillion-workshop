// GET /work/api/client-version (tool:answer-which-page-builds-may-keep-working), with old trillion's
// test/client-version.test.mjs at tag old-trillion-before-worker-retire ported to it: a build below the minimum, or a tab
// opened before the lock-out time, is locked out and nothing else is, and the shipped DATA never locks out the build it
// ships with. The page half of that test (src/workspace/client-version.ts, the reload screen) moved with the page to
// Trillion-X/trillion-apps web/ and is tested there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { answerClientVersion } from '../do-work/answer-client-version.mjs';
import { clientVersionAnswer, lockedOut } from '../src/client-version.mjs';
import settings from '../src/client-version.json' with { type: 'json' };

test('a build below the minimum, or a tab opened before the lock-out time, is locked out; nothing else is', () => {
  const opened = Date.parse('2026-10-19T10:00:00Z');
  assert.equal(lockedOut({ minimum_generation: 3, lock_out_before: null }, { generation: 2, openedAt: opened }), true);
  assert.equal(lockedOut({ minimum_generation: 3, lock_out_before: null }, { generation: 3, openedAt: opened }), false);
  assert.equal(lockedOut({ minimum_generation: 1, lock_out_before: '2026-10-19T11:00:00Z' }, { generation: 3, openedAt: opened }), true, 'opened before the cutoff');
  assert.equal(lockedOut({ minimum_generation: 1, lock_out_before: '2026-10-19T09:00:00Z' }, { generation: 3, openedAt: opened }), false, 'opened after the cutoff');
  for (const failed of [null, 'nope', {}, { minimum_generation: 'x', lock_out_before: 'not a time' }]) assert.equal(lockedOut(failed, { generation: 1, openedAt: opened }), false, JSON.stringify(failed));
  assert.deepEqual(clientVersionAnswer(), { minimum_generation: settings.minimum_generation, lock_out_before: settings.lock_out_before });
  assert.equal(lockedOut(clientVersionAnswer(), { generation: settings.generation, openedAt: Date.now() }), false, 'the shipped DATA never locks out the build it ships with');
});

test('GET /client-version answers the DATA the tool carries; any other route or method is not found', () => {
  assert.deepEqual(answerClientVersion({ path: '/client-version', method: 'GET', query: {}, body: {} }), { status: 200, body: clientVersionAnswer() });
  assert.deepEqual(answerClientVersion({ path: '/client-version', method: 'POST', query: {}, body: {} }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(answerClientVersion({ path: '/client-version/other', method: 'GET' }), { status: 404, body: { error: 'Not found' } });
});

test('the row answers the page route as the container runs it', async () => {
  const row = rowOf(rows, 'tool:answer-which-page-builds-may-keep-working');
  const answer = await answerOf(row, { path: '/client-version', method: 'GET', query: {}, body: {}, browser: { user_agent: 'test', origin: 'https://app.example', visitor: '' } });
  assert.equal(answer.status, 0, JSON.stringify(answer));
  assert.deepEqual(answer.result, { status: 200, body: clientVersionAnswer() });
  assert.equal(lockedOut(answer.result.body, { generation: settings.generation, openedAt: Date.now() }), false);
});
