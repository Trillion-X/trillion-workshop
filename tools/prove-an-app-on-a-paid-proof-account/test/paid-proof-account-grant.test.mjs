import test from 'node:test';
import assert from 'node:assert/strict';
import { grantPaidPlan } from '../scripts/paid-proof-account.mjs';

const accountId = '00000000-0000-4000-8000-000000000001';

test('a refused account lookup never sends an owner grant, even when the body names an account', async () => {
  const calls = [], attempts = [];
  await assert.rejects(grantPaidPlan('synthetic-proof', 'https://proof.example.test', 'unused', {
    request: async url => { calls.push(url); return Response.json({ user_id: accountId }, { status: 503 }); },
    onAttempt: row => attempts.push(row),
  }), /HTTP 503.*No plan grant was sent/);
  assert.deepEqual(calls, ['https://proof.example.test/mcp/api/account']);
  assert.equal(attempts[0].stage, 'account');
  assert.equal(attempts[0].status, 503);
});

test('an incomplete or malformed account read cannot fall back to granting the operator', async () => {
  for (const content of [{}, { user_id: '' }, { user_id: 'someone' }, { error: 'Busy' }, null, 'not JSON']) {
    const calls = [];
    await assert.rejects(grantPaidPlan('synthetic-proof', 'https://proof.example.test', 'unused', {
      request: async url => {
        calls.push(url);
        return typeof content === 'string' ? new Response(content) : Response.json(content);
      },
    }), /account ID.*No plan grant was sent/);
    assert.deepEqual(calls, ['https://proof.example.test/mcp/api/account']);
  }
});

 test('proof grants stop after two unchanged busy replies without changing the target', async()=>{
 const attempts=[], targets=[];
 await assert.rejects(grantPaidPlan('synthetic-proof','https://proof.example.test','unused',{
  operatorKey:'synthetic-operator',retryDelayMs:0,onAttempt:row=>attempts.push(row),
  request:async(url,options)=>{
   if(url.endsWith('/account'))return Response.json({user_id:accountId});
   targets.push(JSON.parse(options.body).user_id);
   return Response.json({error:'Busy'},{status:503});
  },
 }),/service answered 503/);
 assert.deepEqual(targets,[accountId,accountId]);
 assert.deepEqual(attempts.filter(row=>row.stage==='grant').map(row=>row.attempt),[1,2]);
 });
 test('a second proof grant may succeed only with actual paid access readback',async()=>{
 let grants=0;
 assert.equal(await grantPaidPlan('synthetic-proof','https://proof.example.test','unused',{
  operatorKey:'synthetic-operator',retryDelayMs:0,
  request:async url=>url.endsWith('/account')?Response.json({user_id:accountId})
   :++grants===1?Response.json({error:'Busy'},{status:503})
   :Response.json({access:{capabilities:['access:decision-kept']}}),
 }),accountId);
 assert.equal(grants,2);
 });
