// tools/use-your-tools-from-a-shell/test/command-schedule-names-the-computer.test.mjs
//
// `schedule list`, `schedule on` and `schedule off` say which computer answered. The engine's meeting point does not name the
// answering computer on a list, so the command asks for the carried computers by a pin no computer has (the refusal names
// them) and asks each one by its own pin: one block per computer, each under its name. A switch is named by its one pin, or
// by the one carried computer the engine did not pass the switch to. These tests drive the whole command with a fake engine
// that answers as the meeting point does (command-pin-route.test.mjs shows the same seam).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const NOT_CARRIED = settings.engine.carried.not_carried;

/** The engine's refusal for pins no carried computer answers: its words name the carried computers, as meeting.rs `pinned()` does. */
const refusal = (pins, carried) => ({
  isError: true,
  structuredContent: { code: NOT_CARRIED, detail: carried.length
    ? `No computer you pinned is carried here now (${pins.join(', ')}); yours carried now: ${carried.join(', ')}.`
    : `No computer you pinned is carried here now (${pins.join(', ')}); none of yours is carried now.` },
  content: [],
});

/** A fake engine for one person: `carried` are the computers carried now (in the order the engine names them), `wakes` the
 *  wakes each declares. A switch on lands at the first pin carried, or at the first carried computer when unpinned, and
 *  names every other carried computer under `elsewhere`; a switch off pinned to computers names none (as meeting.rs does). */
function engineFor({ carried, wakes }) {
  const asked = [];
  const reply = args => {
    const pins = args.pins ?? [];
    const named = pins.filter(pin => carried.includes(pin));
    if (args.method === 'wake:list') {
      if (!named.length) return refusal(pins, carried);
      return { structuredContent: { wakes: wakes[named[0]] }, content: [] };
    }
    // With no computer announced the meeting point is not in the path: the engine answers the call itself, with nothing elsewhere.
    if (!carried.length) return args.method === 'wake:list' ? { structuredContent: { wakes: [] }, content: [] } : { structuredContent: { on: args.input.on }, content: [] };
    if (args.method === 'wake:switch') {
      const at = pins.length ? named[0] : carried[0];
      if (!at) return refusal(pins, carried);
      const others = carried.filter(computer => computer !== at);
      const elsewhere = args.input.on || pins.length === 0 ? others.map(computer => ({ computer, off: true })) : [];
      return { structuredContent: { on: args.input.on, ...(elsewhere.length ? { elsewhere } : {}) }, content: [] };
    }
    throw new Error(`unexpected ${args.method}`);
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { [settings.engine.account_meta]: { account_id: 'acct' } }, serverInfo: {}, capabilities: { tools: {} } } });
    asked.push(body.params.arguments);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: reply(body.params.arguments) });
  };
  return { asked, fetchImpl };
}

/** Runs the command against `engine`; resolves to the printed text. */
const run = (engine, argv) => main([...argv, '--origin', 'http://127.0.0.1:8788'], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants,
  state: stateOf({ home: tempFolder(join(tmpdir(), 'example-names-computer-')) }),
  fetchImpl: engine.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const wakes = {
  mac: [{ tool: 'tool:x', id: 'daily', switched_on: false }],
  'always-on': [{ tool: 'tool:x', id: 'daily', switched_on: true }, { tool: 'tool:y', id: 'weekly', switched_on: true }],
  mac_b: [{ tool: 'tool:z', id: 'hourly', switched_on: true }],
};

test('schedule list with no --pin prints one block per carried computer, each under its own name, with that computer\'s wakes', async () => {
  const engine = engineFor({ carried: ['mac', 'always-on'], wakes });
  const text = await run(engine, ['schedule', 'list']);
  const lines = text.split('\n');
  assert.equal(lines[0], 'answered by: mac', 'the first line says which computer answered');
  assert.ok(lines.includes('answered by: always-on'), text);
  assert.ok(text.indexOf('answered by: mac') < text.indexOf('answered by: always-on'), 'blocks in the order the engine named them');
  assert.ok(text.includes('"id": "daily"') && text.includes('"id": "weekly"'), 'each computer\'s own wakes are printed');
  assert.deepEqual(engine.asked.map(args => args.method), ['wake:list', 'wake:list', 'wake:list'], 'one probe, then one pinned read per carried computer');
  assert.deepEqual(engine.asked.slice(1).map(args => args.pins), [['mac'], ['always-on']]);
});

test('a list with one carried computer prints one block, named', async () => {
  const engine = engineFor({ carried: ['mac'], wakes });
  const text = await run(engine, ['schedule', 'list']);
  assert.equal(text.split('\n')[0], 'answered by: mac');
  assert.equal(text.split('\n').filter(line => line.startsWith('answered by:')).length, 1);
});

test('a list when the engine says none of yours is carried prints that refusal, headed by no computer, and reads no wakes', async () => {
  const engine = engineFor({ carried: [], wakes });
  const text = await run(engine, ['schedule', 'list']);
  assert.equal(text.split('\n')[0], 'answered by: unnamed (none of your computers was named)');
  assert.ok(text.includes('none of yours is carried now'), text);
  assert.ok(!text.includes('"wakes"'), 'no wakes are read as the whole state');
  assert.deepEqual(engine.asked.map(args => args.method), ['wake:list'], 'one probe, and no read of any computer');
});

test('a refusal whose words name no carried computer is printed as that refusal, under no computer\'s name', async () => {
  const words = { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { [settings.engine.account_meta]: { account_id: 'acct' } }, serverInfo: {}, capabilities: { tools: {} } } });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: { code: NOT_CARRIED, detail: 'No computer you pinned is carried here now (x); something else.' }, content: [] } });
  } };
  const text = await run(words, ['schedule', 'list']);
  assert.equal(text.split('\n')[0], 'answered by: unnamed (none of your computers was named)');
  assert.ok(text.includes('something else'), text);
});

test('schedule list --pin names the pinned computer on its block; a pin not carried is headed as not answered', async () => {
  const single = engineFor({ carried: ['mac', 'always-on'], wakes });
  assert.equal((await run(single, ['schedule', 'list', '--pin', 'always-on'])).split('\n')[0], 'answered by: always-on');
  assert.deepEqual(single.asked.map(args => args.pins), [['always-on']], 'a pinned list is one read, to that computer');

  const both = engineFor({ carried: ['mac', 'always-on'], wakes });
  const text = await run(both, ['schedule', 'list', '--pin', 'mac,ghost']);
  assert.equal(text.split('\n')[0], 'answered by: mac');
  assert.ok(text.includes('not answered by: ghost'), text);
  assert.ok(text.includes('yours carried now: mac, always-on'), 'the refusal says which computers are carried');
});

test('computer ids with dashes and underscores are read from the refusal', async () => {
  const engine = engineFor({ carried: ['mac_b', 'always-on'], wakes });
  const text = await run(engine, ['schedule', 'list']);
  assert.ok(text.includes('answered by: mac_b') && text.includes('answered by: always-on'), text);
});

test('schedule on with no --pin names the computer that switched it: the one carried computer the switch did not pass to', async () => {
  const engine = engineFor({ carried: ['mac', 'always-on'], wakes });
  const text = await run(engine, ['schedule', 'on', 'tool:x', 'daily']);
  assert.equal(text.split('\n')[0], 'answered by: mac');
  assert.ok(text.includes('"elsewhere"') && text.includes('"computer": "always-on"'), 'the other computer is still named with its outcome');
});

test('schedule off with no --pin names the computer that switched it, from the same elsewhere names', async () => {
  const engine = engineFor({ carried: ['always-on', 'mac'], wakes });
  const text = await run(engine, ['schedule', 'off', 'tool:x', 'daily']);
  assert.equal(text.split('\n')[0], 'answered by: always-on');
});

test('schedule on --pin names that pin, and a pinned switch off names it too (it names no other computer)', async () => {
  const engine = engineFor({ carried: ['mac', 'always-on'], wakes });
  const on = await run(engine, ['schedule', 'on', 'tool:x', 'daily', '--pin', 'always-on']);
  assert.equal(on.split('\n')[0], 'answered by: always-on');
  const off = await run(engine, ['schedule', 'off', 'tool:x', 'daily', '--pin', 'mac']);
  assert.equal(off.split('\n')[0], 'answered by: mac');
  assert.ok(!off.includes('"elsewhere"'), 'a switch off pinned to a computer touches only that computer');
});

test('a switch with one carried computer and no other names is named by that computer', async () => {
  const engine = engineFor({ carried: ['mac'], wakes });
  assert.equal((await run(engine, ['schedule', 'on', 'tool:x', 'daily'])).split('\n')[0], 'answered by: mac');
});

test('a switch that cannot tell which computer answered says so; it never guesses', async () => {
  const engine = engineFor({ carried: [], wakes });
  assert.equal((await run(engine, ['schedule', 'on', 'tool:x', 'daily'])).split('\n')[0], 'answered by: unnamed (none of your computers was named)');
});

test('a refusal other than the pins\' is not swallowed by the carried-computers probe', async () => {
  const engine = engineFor({ carried: ['mac'], wakes });
  const broken = { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return engine.fetchImpl(url, init);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: { code: 'tools_tool_credential_unavailable', detail: 'The vault is locked.' }, content: [] } });
  } };
  await assert.rejects(run(broken, ['schedule', 'list']), error => error.answer?.code === 'tools_tool_credential_unavailable' || /vault is locked/.test(error.message));
});
