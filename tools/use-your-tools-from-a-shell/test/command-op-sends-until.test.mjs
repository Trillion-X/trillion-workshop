// tools/use-your-tools-from-a-shell/test/command-op-sends-until.test.mjs
//
// A tool run asked with --timeout carries `until` (now plus that wait), so a door that carries the call to another computer
// waits that long for its answer instead of its own default; the `until` is kept per request key, so the same command asked
// again under its key sends the same request. A run that names its own `until`, another method, or no --timeout is sent as given.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, withUntil, speakFor } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-op-until-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const RUN = settings.engine.tools_run;

test('a tool run with --timeout carries until, kept per request key', () => {
  const state = stateOf({ home: home() });
  const first = withUntil(RUN, { tool: 'tool:x', input: {} }, { requestKey: 'k1', timeoutSeconds: 1300, state, now: () => 1_000 });
  assert.deepEqual(first, { tool: 'tool:x', input: {}, until: 1_000 + 1_300_000 });
  const again = withUntil(RUN, { tool: 'tool:x', input: {} }, { requestKey: 'k1', timeoutSeconds: 1300, state, now: () => 9_999_999 });
  assert.equal(again.until, first.until, 'the same key sends the same until');
  const other = withUntil(RUN, { tool: 'tool:x', input: {} }, { requestKey: 'k2', timeoutSeconds: 10, state, now: () => 5_000 });
  assert.equal(other.until, 15_000);
});

test('a run with its own until, another method, or no --timeout is sent as given', () => {
  const state = stateOf({ home: home() });
  const own = { tool: 'tool:x', input: {}, until: 42 };
  assert.equal(withUntil(RUN, own, { requestKey: 'k', timeoutSeconds: 60, state }), own);
  const write = { tool: 'tool:x', id: 'daily', on: true };
  assert.equal(withUntil('wake:switch', write, { requestKey: 'k', timeoutSeconds: 60, state }), write);
  const plain = { tool: 'tool:x', input: {} };
  assert.equal(withUntil(RUN, plain, { requestKey: 'k', state }), plain);
  // A session call takes no until: the engine refuses one that names it.
  const call = { tool: 'tool:your-files', call: { name: 'read_file', arguments: { name_or_identity: '/a.txt' } } };
  assert.equal(withUntil(RUN, call, { requestKey: 'k', timeoutSeconds: 60, state }), call);
});

test('op tools:run --timeout sends until in the request, the same on a second command under its key', async () => {
  const state = stateOf({ home: home() });
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.params.arguments.input);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { result: { ok: true } }, content: [] } });
  };
  const run = () => main(['op', RUN, '{"tool":"tool:x","input":{}}', '--timeout', '600', '--request-key', 'long-run-1', '--origin', ORIGIN], {
    env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state,
    fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  const before = Date.now();
  await run();
  await run();
  assert.equal(sent.length, 2);
  assert.ok(sent[0].until >= before + 600_000 && sent[0].until <= Date.now() + 600_000, String(sent[0].until));
  assert.equal(sent[1].until, sent[0].until);
});
