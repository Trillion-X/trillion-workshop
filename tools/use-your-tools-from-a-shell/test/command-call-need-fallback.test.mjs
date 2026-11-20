// tools/use-your-tools-from-a-shell/test/command-call-need-fallback.test.mjs
//
// `{cli} call TOOL JSON` sends the tool's `need` in the tools:run envelope. An engine older than trillion-rust 9133c735e
// refuses that envelope with engine.need_refusal and nothing else: the command sends the same call once more without
// `need`. A new engine gets `need` on the first try, and every other refusal is passed through with no retry.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, speakFor } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'cd'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-call-need-fallback-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const NEED = { local_doors: [{ name: 'gpu', required: true }], when_offline: 'queue' };
const refusal = settings.engine.need_refusal;

/** A fake door. `refuse(args)` returns a JSON-RPC error for a tools:run envelope, or null to answer it. tools:list answers
 *  the run template `{ address, method, need }`. Every envelope it is sent is kept in `seen`. */
function fakeDoor({ refuse = () => null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const args = body.params.arguments;
    seen.push(args);
    if (args.method === 'tools:list') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { id: args.input.tool, run: { address: 'x', method: 'tools:run', need: NEED } }, content: [] } });
    }
    const error = refuse(args);
    if (error) return Response.json({ jsonrpc: '2.0', id: body.id, error });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ran: true }, content: [] } });
  };
  return { seen, fetchImpl };
}

const run = (argv, door) => main([...argv, '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const runEnvelopes = door => door.seen.filter(args => args.method === 'tools:run');
const CALL = ['call', 'mcp/needs-gpu', '{"text":"hi"}'];

test('an old engine refuses need, and the same call goes once more without it', async () => {
  let refusals = 0;
  const door = fakeDoor({ refuse: args => (Object.hasOwn(args, 'need') ? (refusals += 1, refusal) : null) });
  await run(CALL, door);
  const [first, second] = runEnvelopes(door);
  assert.equal(runEnvelopes(door).length, 2, 'one refused call and one retry');
  assert.deepEqual(first.need, NEED, 'the first try carries need');
  assert.equal(Object.hasOwn(second, 'need'), false, 'the retry carries no need');
  assert.deepEqual(second.input, { tool: 'mcp/needs-gpu', input: { text: 'hi' } }, 'the retry is the same call otherwise');
  assert.equal(second.request_key, first.request_key, 'the retry keeps the request key');
  assert.equal(refusals, 1, 'refused once');
});

test('a new engine gets need on the first try and no retry happens', async () => {
  const door = fakeDoor();
  await run(CALL, door);
  const envelopes = runEnvelopes(door);
  assert.equal(envelopes.length, 1, 'one call');
  assert.deepEqual(envelopes[0].need, NEED, 'need is sent on the first try');
});

test('any other refusal is passed through unchanged, with no retry', async () => {
  const other = { code: -32602, message: 'Addressed resource arguments are incomplete: `input` is not an object.' };
  for (const error of [other, { ...refusal, code: -32603 }, { ...refusal, message: `${refusal.message} extra` }]) {
    const door = fakeDoor({ refuse: args => (Object.hasOwn(args, 'need') ? error : null) });
    await assert.rejects(run(CALL, door), error2 => {
      assert.equal(error2.answer.message, error.message, 'the engine message is passed through');
      return true;
    });
    assert.equal(runEnvelopes(door).length, 1, 'no retry');
    assert.deepEqual(runEnvelopes(door)[0].need, NEED, 'the one try carried need');
  }
});

test('the need refusal on a call without need is not retried', async () => {
  const door = fakeDoor({ refuse: () => refusal });
  await assert.rejects(run(['op', 'tools:run', '{"tool":"mcp/echo","input":{}}'], door), error => error.answer.message === refusal.message);
  assert.equal(runEnvelopes(door).length, 1, 'no retry for a call that carries no need');
});
