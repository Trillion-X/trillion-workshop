import assert from 'node:assert/strict';
import test from 'node:test';
import { admitProofWorkspace, removeProofWorkspace, verifyProofWorkspaceOwner } from '../scripts/paid-proof-account.mjs';
const accountId = '779c2c43-c853-481e-a2fc-7f8b10aaacbd';

test('a timed-out admission can be cleaned by exact account id without its returned handle', async () => {
  const accountId = '779c2c43-c853-481e-a2fc-7f8b10aaacbd';
  const calls = [];
  const options = {
    operatorKey: 'test-only-key',
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/show-rules')) return Response.json({ authority: 'operator', rules: [] });
      if (url.endsWith('/set')) throw new DOMException('Lost policy write response', 'TimeoutError');
      if (calls.length === 3) return Response.json({ code: 'service-busy' }, { status: 503 });
      return Response.json({ rules: [], said: 'Taken away.' });
    },
  };
  let handle;
  await assert.rejects(async () => { handle = await admitProofWorkspace(accountId, 'https://proof.example', 'unused', options); },
    /Lost policy write response/);
  assert.equal(handle, undefined);
  assert.equal(calls.length, 4);
  for (const call of calls.slice(2)) {
    assert.equal(call.url, 'https://proof.example/mcp/api/show-rules/remove');
    assert.equal(call.options.method, 'POST');
    assert.deepEqual(JSON.parse(call.options.body), { id: `disposable-workspace-${accountId}` });
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('cleanup refuses a successful reply that still lists its exact rule', async () => {
  const accountId = '7bb42d51-abe0-4e8f-b8a6-1e226105b892';
  await assert.rejects(removeProofWorkspace(accountId, 'https://proof.example', 'unused', {
    operatorKey: 'test-only-key', request: async () => Response.json({ rules: [{ id: `disposable-workspace-${accountId}` }] }),
  }), /remains after removal/);
});

test('workspace owner preflight only reads and fails closed on a busy or non-operator owner', async () => {
  for (const [status, answer] of [[200, { authority: 'operator' }], [200, { authority: 'personal' }], [503, { code: 'service-busy' }]]) {
    const calls = [];
    const operation = verifyProofWorkspaceOwner('https://proof.example', 'unused', {
      operatorKey: 'test-only-key', request: async (url, options) => {
        calls.push({ url, options }); return Response.json(answer, { status });
      },
    });
    if (status === 200 && answer.authority === 'operator') assert.deepEqual(await operation, { available: true });
    else await assert.rejects(operation, /policy owner read/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://proof.example/mcp/api/show-rules');
    assert.equal(calls[0].options.body, undefined);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  }
});


test('exact proof policy removal retries busy and timed-out replies without changing its account', async () => {
  for (const first of ['busy', 'timeout']) {
    const bodies = [];
    const answer = await removeProofWorkspace(accountId, 'https://proof.example', 'unused', {
      operatorKey: 'test-only-key', retryDelayMs: 0, request: async (_url, options) => {
        bodies.push(options.body);
        if (bodies.length === 1) {
          if (first === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
          return Response.json({ code: 'service-busy' }, { status: 503 });
        }
        return Response.json({ rules: [] });
      },
    });
    assert.deepEqual(answer.rules, []);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(bodies[0]).id, `disposable-workspace-${accountId}`);
  }
});

test('exact proof policy removal bounds busy retries and never retries a permission refusal', async () => {
  for (const status of [503, 403]) {
    let calls = 0;
    await assert.rejects(removeProofWorkspace(accountId, 'https://proof.example', 'unused', {
      operatorKey: 'test-only-key', retryDelayMs: 0, request: async () => {
        calls += 1;
        return Response.json({ code: status === 503 ? 'service-busy' : 'forbidden' }, { status });
      },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, status === 503 ? 3 : 1);
  }
});


test('workspace admission retries its temporary policy read and then writes once', async () => {
  for (const first of ['busy', 'timeout']) {
    const calls=[];let reads=0;
    const handle=await admitProofWorkspace(accountId,'https://proof.example','unused',{
      operatorKey:'test-only-key',retryDelayMs:0,request:async(url,options)=>{
        calls.push({url,method:options.method});
        if(url.endsWith('/show-rules')){
          if(++reads===1){if(first==='timeout')throw new DOMException('temporary read timeout','TimeoutError');return Response.json({code:'service-busy'},{status:503});}
          return Response.json({authority:'operator',rules:[]});
        }
        const {rule}=JSON.parse(options.body);return Response.json({rule});
      },
    });
    assert.equal(handle.account_id,accountId);assert.deepEqual(calls.map(c=>c.method),['GET','GET','POST']);
    assert.equal(calls.filter(c=>c.url.endsWith('/set')).length,1);
  }
});

test('workspace admission never retries a denied policy read or invents a policy write', async () => {
  const calls=[];
  await assert.rejects(admitProofWorkspace(accountId,'https://proof.example','unused',{
    operatorKey:'test-only-key',retryDelayMs:0,request:async(url,options)=>{calls.push({url,method:options.method});return Response.json({code:'forbidden'},{status:403});},
  }),/HTTP 403/);
  assert.deepEqual(calls.map(c=>c.method),['GET']);
});
