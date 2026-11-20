// tools/use-your-tools-from-a-shell/test/command-op-settles-writes.test.mjs
//
// `example op` reads a write the engine keeps to its outcome: a write answered accepted and
// pending is asked again under its own request key until the writer settles it. A commit prints; a refusal is thrown (the
// command exits non-zero and says why); a write still pending past the settle window is thrown as write_pending. The wait
// is the one settled-write.mjs owns.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, CommandError, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-op-settle-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const WRITE = ['op', 'wake:switch', '{"tool":"tool:x","id":"daily","on":true}'];

/** A fake door: each write answer is the next of `answers`; every call is kept in `seen` with its request key. */
function fakeDoor(answers) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ key: body.params.arguments.request_key });
    const next = answers[seen.length - 1] ?? answers.at(-1);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: next });
  };
  return { seen, fetchImpl };
}
const pending = requestKey => ({ structuredContent: { accepted: true, pending: true, request_key: requestKey }, content: [] });
const committed = { structuredContent: { committed: true, write_count: 1 }, content: [] };
const refused = { isError: true, structuredContent: { code: 'command_settle_mismatch', cause: 'test.rs:1:1' }, content: [] };

const run = (argv, door, folder = home()) => main([...argv, '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: folder }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

test('example op asks a pending write again under its own key until the writer commits it', async () => {
  const door = fakeDoor([pending('k-1'), pending('k-1'), committed]);
  const output = await run(WRITE, door);
  assert.equal(door.seen.length, 3, 'the same write is asked again while it is pending');
  assert.deepEqual([...new Set(door.seen.map(call => call.key))].length, 1, 'every ask carries one request key');
  assert.match(output, /"committed": true/);
});

test('example op refuses a pending write the writer later refuses, and says why', async () => {
  const door = fakeDoor([pending('k-2'), refused]);
  await assert.rejects(run(WRITE, door), error => {
    assert.ok(error instanceof CommandError, String(error));
    assert.equal(error.code, 'command_settle_mismatch');
    assert.match(error.detail, /command_settle_mismatch/);
    return true;
  });
  assert.equal(door.seen.length, 2, 'the refusal is read by asking the same key again, not reported as kept');
});
