// tools/workflows/test/workflow-run-find.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowRunFind } from '../read-data/workflow-run-find.mjs';

test('words find the shipped workflow for the job, each match with its exact next start input', async () => {
  const answer = await workflowRunFind({ words: 'make short vertical videos from my recorded footage' });
  assert.equal(answer.chooser, 'not asked: no kinds given');
  assert.equal(answer.matches[0].workflow, 'workflow:make-short-videos-from-footage');
  assert.deepEqual(answer.matches[0].next, {
    tool: 'wf start WORKFLOW_ID (door op workflow:start is not built yet)',
    input: { workflow: 'workflow:make-short-videos-from-footage', input: { request: 'make short vertical videos from my recorded footage' } },
  });
});

test('the answer stays small: at most eight matches, each with a bounded job', async () => {
  const answer = await workflowRunFind({ words: 'videos' });
  assert.ok(answer.matches.length <= 8);
  assert.ok(answer.matches.every(match => match.job.length <= 200));
  assert.ok(JSON.stringify(answer).length < 8192);
});

test('an own row wins over the shipped recipe of the same id and is marked own', async () => {
  const answer = await workflowRunFind({
    words: 'short vertical videos from footage',
    own: [{ id: 'workflow:make-short-videos-from-footage', value: { title: 'My own short videos', job: 'my own job', steps: [] } }],
  });
  const match = answer.matches.find(item => item.workflow === 'workflow:make-short-videos-from-footage');
  assert.equal(match.label, 'My own short videos');
  assert.equal(match.own, true);
  assert.equal(match.job, 'my own job');
});

test('kinds nothing waits for are named back, and the words still answer', async () => {
  const answer = await workflowRunFind({ words: 'short videos', kinds: ['no-such-kind-anywhere'] });
  assert.deepEqual(answer.unknown_kinds, ['no-such-kind-anywhere']);
  assert.match(answer.chooser, /^answered: /);
  assert.ok(answer.matches.length > 0);
});

test('a find with neither words nor kinds is refused', async () => {
  await assert.rejects(workflowRunFind({}), /give words/);
});
