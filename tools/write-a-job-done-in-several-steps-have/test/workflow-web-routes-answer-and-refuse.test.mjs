// tools/write-a-job-done-in-several-steps-have: the workflow web routes answer each verb with its JSON, refuse what is
// not a route, a bad request or an oversized body in plain words, and keep an unexpected failure as a reference the
// person can quote. Ported from the older version's handleWorkflowRequest (src/workflows.mjs.held, at b6ae0ebf81).
import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowError, handleWorkflowRequest, isWorkflowPath } from '../read-data/workflows.mjs';

// A workflows object whose verbs record what they were called with.
function fakeWorkflows(overrides = {}) {
  const calls = [];
  const verb = name => async (input, options) => { calls.push({ name, input, options }); return { ok: name, input }; };
  const workflows = {
    find: verb('find'), describe: verb('describe'), start: verb('start'), submit: verb('submit'), read: verb('read'),
    snapshot: verb('snapshot'), stop: verb('stop'), save: verb('save'), adopt: verb('adopt'), upgrade: verb('upgrade'),
    publish: verb('publish'), unpublish: verb('unpublish'), remove: verb('remove'), restore: verb('restore'), sources: verb('sources'),
    runs: async input => { calls.push({ name: 'runs', input }); return { runs: [] }; },
    ...overrides,
  };
  return { workflows, calls };
}

const post = (path, body, headers = {}) => new Request(`https://person.example${path}`, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

test('a workflow path is one under /workflows', () => {
  assert.equal(isWorkflowPath('/workflows'), true);
  assert.equal(isWorkflowPath('/workflows/find'), true);
  assert.equal(isWorkflowPath('/workflow-things'), false);
});

test('each POST route calls its verb with the body, and the reader header goes along', async () => {
  const { workflows, calls } = fakeWorkflows();
  const reply = await handleWorkflowRequest(workflows, post('/workflows/find', { job: 'write a plan' }, { 'x-reader': 'app:Claude' }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: 'find', input: { job: 'write a plan' } });
  assert.deepEqual(calls[0].options, { reader: 'app:Claude' });
  const none = await handleWorkflowRequest(workflows, post('/workflows/describe'));
  assert.deepEqual(await none.json(), { ok: 'describe', input: {} }, 'an empty body is an empty request');
  assert.equal(calls[1].options.reader, null, 'no reader header means no reader');
});

test('GET /workflows/runs passes its before and limit to runs', async () => {
  const { workflows, calls } = fakeWorkflows();
  const reply = await handleWorkflowRequest(workflows, new Request('https://person.example/workflows/runs?before=abc&limit=5'));
  assert.equal(reply.status, 200);
  assert.deepEqual(calls[0].input, { before: 'abc', limit: '5' });
});

test('a path that is not a route, or a GET on a verb, is Not found', async () => {
  const { workflows } = fakeWorkflows();
  const unknown = await handleWorkflowRequest(workflows, post('/workflows/nope', {}));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Not found' });
  const getVerb = await handleWorkflowRequest(workflows, new Request('https://person.example/workflows/find'));
  assert.equal(getVerb.status, 404);
});

test('a refusal the person can act on is a 400 with its problems and next call', async () => {
  const { workflows } = fakeWorkflows({
    start: async () => { throw Object.assign(new WorkflowError('input does not fit the input schema'), { problems: ['input.job is required.'], next_call: { tool: 'describe_workflow' } }); },
  });
  const reply = await handleWorkflowRequest(workflows, post('/workflows/start', {}));
  assert.equal(reply.status, 400);
  const body = await reply.json();
  assert.equal(body.error, 'input does not fit the input schema');
  assert.deepEqual(body.problems, ['input.job is required.']);
  assert.deepEqual(body.next_call, { tool: 'describe_workflow' });
  assert.equal(body.code, undefined, 'a refusal carries no internal code');
});

test('a malformed JSON body is a 400, not a server failure', async () => {
  const { workflows } = fakeWorkflows();
  const reply = await handleWorkflowRequest(workflows, new Request('https://person.example/workflows/find', { method: 'POST', body: '{not json' }));
  assert.equal(reply.status, 400);
});

test('an oversized body is refused before any verb runs', async () => {
  const { workflows, calls } = fakeWorkflows();
  const reply = await handleWorkflowRequest(workflows, post('/workflows/save', { workflow: 'x'.repeat(4_000_001) }));
  assert.equal(reply.status, 400);
  assert.match((await reply.json()).error, /Request too large/);
  assert.equal(calls.length, 0);
});

test('an unexpected failure is a 500 with a reference, and is reported once with its operation', async () => {
  const reported = [];
  const { workflows } = fakeWorkflows({ find: async () => { throw new TypeError('cannot read properties of undefined'); } });
  const reply = await handleWorkflowRequest(workflows, post('/workflows/find', {}), { reportUnexpected: event => reported.push(event) });
  assert.equal(reply.status, 500);
  const body = await reply.json();
  assert.equal(body.code, 'workflow_internal_failure');
  assert.match(body.reference, /^[0-9a-f]{16}$/);
  assert.equal(body.error, 'cannot read properties of undefined');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].event, 'workflow_operation_failed');
  assert.equal(reported[0].reference, body.reference);
  assert.equal(reported[0].operation, 'find');
  assert.equal(reported[0].error_class, 'TypeError');
});
