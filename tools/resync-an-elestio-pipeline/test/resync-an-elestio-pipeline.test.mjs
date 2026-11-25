// tools/resync-an-elestio-pipeline/test/resync-an-elestio-pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeElestio, resyncAnElestioPipeline } from '../do-work/resync-an-elestio-pipeline.mjs';

const COMMIT = 'e54510478825db70e7126c4dd1dabd5f7fb5db54';
const OLD = '8a9490d2a1f0c3b4d5e6f708192a3b4c5d6e7f80';
const request = { email: 'owner@example.test', project_id: '90000', vm_id: '170000000', pipeline_id: '20000', commit: 'e545104', poll_seconds: 1 };

// The run before the ask, as getHistory answered it for the school pipeline on Nov 25 2026.
const earlier = { id: 323016, pipelineID: '20000', action: 'Resync', status: 'Success', logID: '2026-11-25-07.39.38.205.log', startTime: '2026-11-25T07:42:36.000Z', endTime: '2026-11-25T07:42:46.000Z', commitID: COMMIT, commitMessage: 'NULL', creationDate: '2026-11-25T07:39:38.000Z', errorMessage: null, duration: 10 };
const ours = (fields = {}) => ({ id: 323072, pipelineID: '20000', action: 'Resync', status: 'Queue', logID: '2026-11-25-08.28.24.226.log', startTime: null, endTime: null, commitID: 'NULL', commitMessage: 'NULL', creationDate: '2026-11-25T08:28:24.000Z', errorMessage: null, duration: null, ...fields });

// A stand-in Elestio: each getHistory read answers the next of `histories` (the last repeats); details answer `deployed`.
function standIn(histories, { deployed = COMMIT } = {}) {
  const asked = [];
  let read = 0;
  const post = async (step, path, body) => {
    asked.push({ step, body });
    if (path === 'auth/checkAPIToken') return { status: 'OK', jwt: 'made-up-session' };
    if (path === 'cicd/getPipelineDetails') return { ...{ deployedCommit: deployed, status: 'deployed', buildStatus: 'success' }, deployPrivateKey: 'made-up-deploy-key', webhookSecret: 'made-up-webhook-secret' };
    if (body.action === 'reSyncPipeline') return { status: 'OK' };
    const runs = histories[Math.min(read, histories.length - 1)];
    read += 1;
    return { status: 'OK', data: runs };
  };
  return { asked, post };
}

// A clock that moves only when waited on.
function clock(start = Date.parse('2026-11-25T08:28:24Z')) {
  let at = start;
  return { now: () => at, wait: async ms => { at += ms; } };
}
const run = (histories, extra = {}, options) => {
  const { asked, post } = standIn(histories, options);
  return resyncAnElestioPipeline({ ...request, ...extra }, { read: () => 'made-up-token\n', post, ...clock() }).then(answer => ({ answer, asked }));
};

test('the new Resync run ending Success on the pushed commit is done, read from the school run of Nov 25 2026', async () => {
  // The real order: lastUpdate moved at the ask (08:28:24) while the run sat in Queue, and the run ran 08:31:16-08:31:25.
  const { answer, asked } = await run([
    [earlier],
    [ours(), earlier],
    [ours({ status: 'Building', startTime: '2026-11-25T08:31:16.000Z' }), earlier],
    [ours({ status: 'Success', startTime: '2026-11-25T08:31:16.000Z', endTime: '2026-11-25T08:31:25.000Z', commitID: COMMIT, duration: 9 }), earlier],
  ]);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.run, { id: 323072, action: 'Resync', status: 'Success', commit: COMMIT, created: '2026-11-25T08:28:24.000Z', started: '2026-11-25T08:31:16.000Z', ended: '2026-11-25T08:31:25.000Z', seconds: 9, log: '2026-11-25-08.28.24.226.log' });
  assert.equal(answer.reads, 3);
  assert.equal(answer.reason, undefined);
  assert.deepEqual(asked[0].body, { email: 'owner@example.test', token: 'made-up-token' });
  assert.deepEqual(asked.find(call => call.body.action === 'reSyncPipeline').body, { jwt: 'made-up-session', projectID: '90000', vmID: '170000000', pipelineID: '20000', action: 'reSyncPipeline' });
  assert.ok(!JSON.stringify(answer).includes('made-up'), 'no token, session, deploy key or webhook secret in the answer');
});

test('a run that only appears late, or sits in Queue and Stuck, is waited for; no clock decides', async () => {
  const { answer } = await run([
    [earlier],
    [earlier],
    [earlier],
    [ours(), earlier],
    [ours({ status: 'Stuck' }), earlier],
    [ours({ status: 'Success', commitID: COMMIT, endTime: '2026-11-25T08:31:25.000Z' }), earlier],
  ]);
  assert.equal(answer.ok, true);
  assert.equal(answer.reads, 5);
});

test('a run that ends within a second of the ask is done on its own record', async () => {
  const { answer } = await run([[earlier], [ours({ status: 'Success', commitID: COMMIT, startTime: '2026-11-25T08:28:24.000Z', endTime: '2026-11-25T08:28:25.000Z', duration: 1 }), earlier]]);
  assert.equal(answer.ok, true);
  assert.equal(answer.reads, 1);
});

test('the earlier run, and a newer run that is not a Resync, are never taken for ours', async () => {
  const webhook = { ...ours({ id: 323073, action: 'GitWebhook', status: 'Success', commitID: COMMIT }) };
  const { answer } = await run([[earlier], [webhook, earlier]], { wait_seconds: 2 });
  assert.equal(answer.ok, false);
  assert.equal(answer.run, null);
  assert.equal(answer.reason, 'no new Resync run appeared in 2 s');
});

test('a Resync run that has not ended is followed, not asked again: a resync downs the site each time', async () => {
  // One call made runs 323099 and 323100 two minutes apart when its runner started it again (Nov 25 2026).
  const building = ours({ id: 323099, status: 'Building', startTime: '2026-11-25T09:05:31.000Z' });
  const { answer, asked } = await run([
    [building, earlier],
    [building, earlier],
    [ours({ id: 323099, status: 'Success', commitID: COMMIT, endTime: '2026-11-25T09:06:23.000Z' }), earlier],
  ]);
  assert.equal(answer.ok, true);
  assert.equal(answer.followed, true);
  assert.equal(answer.run.id, 323099);
  assert.equal(asked.filter(call => call.body.action === 'reSyncPipeline').length, 0);
});

test('a run that ended, or an UpdateBuild still running, does not stop a new ask', async () => {
  const update = { ...ours({ id: 323098, action: 'UpdateBuild', status: 'Building' }) };
  const { answer, asked } = await run([[update, earlier], [ours({ id: 323101, status: 'Success', commitID: COMMIT }), update, earlier]]);
  assert.equal(answer.ok, true);
  assert.equal(answer.followed, false);
  assert.equal(asked.filter(call => call.body.action === 'reSyncPipeline').length, 1);
});

test('a failed or canceled run ends at once with its words', async () => {
  const failed = await run([[earlier], [ours({ status: 'Failed', errorMessage: 'build exited 1' }), earlier]]);
  assert.equal(failed.answer.ok, false);
  assert.equal(failed.answer.reason, 'run 323072 ended Failed: build exited 1');
  const canceled = await run([[earlier], [ours({ status: 'Canceled' }), earlier]]);
  assert.equal(canceled.answer.reason, 'run 323072 ended Canceled');
});

test('a Success on another commit is not ok', async () => {
  const { answer } = await run([[earlier], [ours({ status: 'Success', commitID: OLD }), earlier]]);
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, `run 323072 deployed ${OLD}, not e545104`);
});

test('a run with no commit in its record is judged by the commit the pipeline then serves', async () => {
  const served = await run([[earlier], [ours({ status: 'Success' }), earlier]]);
  assert.equal(served.answer.ok, true);
  const other = await run([[earlier], [ours({ status: 'Success' }), earlier]], {}, { deployed: OLD });
  assert.equal(other.answer.ok, false);
});

test('a run still queued after wait_seconds answers ok false and why', async () => {
  const { answer } = await run([[earlier], [ours(), earlier]], { wait_seconds: 3 });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'run 323072 is still Queue after 3 s');
  assert.equal(answer.reads, 4);
});

test('an empty held token and a bad commit are refused before any call', async () => {
  const { asked, post } = standIn([[earlier]]);
  await assert.rejects(resyncAnElestioPipeline(request, { read: () => '\n', post }), /held Elestio token is empty/);
  await assert.rejects(resyncAnElestioPipeline({ ...request, commit: 'main' }, { read: () => 'x', post }), /commit must be/);
  assert.equal(asked.length, 0);
});

test('a refused call names the step and the service words, with key-like text masked', async () => {
  const post = makeElestio({ send: async () => new Response(JSON.stringify({ status: 'KO', message: 'InvalidCredentials for abcdefghijklmnopqrstuvwxyz0123' }), { status: 401 }) });
  await assert.rejects(post('auth/checkAPIToken', 'auth/checkAPIToken', {}), /^Error: auth\/checkAPIToken answered 401: InvalidCredentials for <masked>$/);
});
