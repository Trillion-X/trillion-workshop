// tools/resync-an-elestio-pipeline/test/resync-an-elestio-pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeElestio, resyncAnElestioPipeline } from '../do-work/resync-an-elestio-pipeline.mjs';

const COMMIT = 'e54510478825db70e7126c4dd1dabd5f7fb5db54';
const OLD = '8a9490d2a1f0c3b4d5e6f708192a3b4c5d6e7f80';
const request = { email: 'owner@example.test', project_id: '90000', vm_id: '170000000', pipeline_id: '20000', commit: 'e545104', poll_seconds: 1 };

// A stand-in Elestio: answers each call from `states` in turn (the last one repeats) and keeps what was asked.
function standIn(states, { session = 'made-up-session' } = {}) {
  const asked = [];
  let read = 0;
  const post = async (step, path, body) => {
    asked.push({ path, body });
    if (path === 'auth/checkAPIToken') return { status: 'OK', jwt: session };
    if (path === 'cicd/doActionOnPipeline') return { status: 'OK' };
    const state = states[Math.min(read, states.length - 1)];
    read += 1;
    return { data: [{ ...state, deployPrivateKey: 'made-up-deploy-key', webhookSecret: 'made-up-webhook-secret' }] };
  };
  return { asked, post };
}

// A clock that moves one second each time it is read or waited on.
function clock(start = Date.parse('2026-11-25T07:39:38Z')) {
  let at = start;
  return { now: () => at, wait: async ms => { at += ms; } };
}

const state = (deployedCommit, lastUpdate, status = 'deployed', buildStatus = 'success') => ({ deployedCommit, lastUpdate, status, buildStatus });

test('a resync that redeploys the pushed commit answers ok with before and after', async () => {
  const { asked, post } = standIn([
    state(OLD, '2026-11-25T07:00:00.000Z'),
    state(OLD, '2026-11-25T07:00:00.000Z'),
    state(OLD, '2026-11-25T07:39:50.000Z', 'deploying', 'building'),
    state(COMMIT, '2026-11-25T07:42:46.000Z'),
  ]);
  const answer = await resyncAnElestioPipeline(request, { read: () => 'made-up-token\n', post, ...clock() });
  assert.equal(answer.ok, true);
  assert.equal(answer.before.deployed_commit, OLD);
  assert.equal(answer.after.deployed_commit, COMMIT);
  assert.equal(answer.reads, 3);
  assert.equal(answer.reason, undefined);
  assert.deepEqual(asked[0].body, { email: 'owner@example.test', token: 'made-up-token' });
  assert.deepEqual(asked[2].body, { jwt: 'made-up-session', projectID: '90000', vmID: '170000000', pipelineID: '20000', action: 'reSyncPipeline' });
  assert.ok(!JSON.stringify(answer).includes('made-up'), 'no token, session, deploy key or webhook secret in the answer');
});

test('the same commit already deployed is not done until the pipeline is deployed again', async () => {
  const { post } = standIn([
    state(COMMIT, '2026-11-25T07:00:00.000Z'),
    state(COMMIT, '2026-11-25T07:00:00.000Z'),
    state(COMMIT, '2026-11-25T07:42:46.000Z'),
  ]);
  const answer = await resyncAnElestioPipeline(request, { read: () => 'made-up-token', post, ...clock() });
  assert.equal(answer.ok, true);
  assert.equal(answer.reads, 2);
});

test('a failed build ends at once with its words', async () => {
  const { post } = standIn([state(OLD, '2026-11-25T07:00:00.000Z'), state(OLD, '2026-11-25T07:40:10.000Z', 'failed', 'failed')]);
  const answer = await resyncAnElestioPipeline(request, { read: () => 'made-up-token', post, ...clock() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'the build ended failed');
});

test('a pipeline still on the old commit after wait_seconds answers ok false and why', async () => {
  const { post } = standIn([state(OLD, '2026-11-25T07:00:00.000Z')]);
  const answer = await resyncAnElestioPipeline({ ...request, wait_seconds: 3 }, { read: () => 'made-up-token', post, ...clock() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, `still serving ${OLD} after 3 s`);
  assert.equal(answer.reads, 4);
});

test('an empty held token and a bad commit are refused before any call', async () => {
  const { asked, post } = standIn([state(OLD, '2026-11-25T07:00:00.000Z')]);
  await assert.rejects(resyncAnElestioPipeline(request, { read: () => '\n', post }), /held Elestio token is empty/);
  await assert.rejects(resyncAnElestioPipeline({ ...request, commit: 'main' }, { read: () => 'x', post }), /commit must be/);
  assert.equal(asked.length, 0);
});

test('a refused call names the step and the service words, with key-like text masked', async () => {
  const post = makeElestio({ send: async () => new Response(JSON.stringify({ status: 'KO', message: 'InvalidCredentials for abcdefghijklmnopqrstuvwxyz0123' }), { status: 401 }) });
  await assert.rejects(post('auth/checkAPIToken', 'auth/checkAPIToken', {}), /^Error: auth\/checkAPIToken answered 401: InvalidCredentials for <masked>$/);
});
