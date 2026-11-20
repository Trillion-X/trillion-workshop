// tools/use-your-tools-from-a-shell/test/command-call-sends-the-need.test.mjs
//
// `{cli} call TOOL JSON` reads the tool's run template (tools:list with `tool`) and sends its `need` in the engine
// envelope of the tools:run call, passed through untouched. A tool whose row needs nothing sends no `need`.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-call-need-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** A fake door that answers tools:list with `runs[tool]` as the row's run template, and tools:run with `{ran: true}`.
 *  Every envelope it is sent is kept in `seen`. */
function fakeDoor(runs) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const args = body.params.arguments;
    seen.push(args);
    const structuredContent = args.method === 'tools:list'
      ? { id: args.input.tool, run: runs[args.input.tool] }
      : { ran: true };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent, content: [] } });
  };
  return { seen, fetchImpl };
}

const run = (argv, door) => main([...argv, '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const runEnvelope = door => door.seen.find(args => args.method === 'tools:run');

test('a row with a required door sends its need, as the run template gives it', async () => {
  const need = { local_doors: [{ name: 'gpu', required: true }, { name: 'judge', required: false }], when_offline: 'queue' };
  const door = fakeDoor({ 'mcp/needs-gpu': { address: 'x', method: 'tools:run', need } });
  await run(['call', 'mcp/needs-gpu', '{"text":"hi"}'], door);
  assert.deepEqual(runEnvelope(door).need, need, 'the run template need is sent as it is');
  assert.deepEqual(runEnvelope(door).input, { tool: 'mcp/needs-gpu', input: { text: 'hi' } }, 'the call itself is unchanged');
});

test('a row whose run template has no need, or a need that names no door, sends no need and no pins', async () => {
  for (const runTemplate of [{ address: 'x', method: 'tools:run' }, { address: 'x', method: 'tools:run', need: { local_doors: [] } }]) {
    const door = fakeDoor({ 'mcp/echo': runTemplate });
    await run(['call', 'mcp/echo', '{"text":"hi"}'], door);
    const envelope = runEnvelope(door);
    assert.equal(Object.hasOwn(envelope, 'need'), false, 'no need key');
    assert.equal(Object.hasOwn(envelope, 'pins'), false, 'no pins key');
    assert.deepEqual(envelope.input, { tool: 'mcp/echo', input: { text: 'hi' } }, 'the call itself is unchanged');
  }
});
