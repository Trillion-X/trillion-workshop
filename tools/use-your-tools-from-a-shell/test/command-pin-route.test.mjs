// tools/use-your-tools-from-a-shell/test/command-pin-route.test.mjs
//
// `example op` and `example schedule` take `--pin COMPUTER_ID`: the computers a call is met at, in the order given. The pins
// go beside method, request_key and input in the one call tool's arguments (the engine reads them as the call's route). A
// --pin is checked against the engine's rule (command.json engine.pins) before anything is sent, and a call with no --pin is
// sent exactly as before.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, CommandError, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const WRITE = ['op', 'wake:switch', '{"tool":"tool:x","id":"daily","on":false}'];
const READ = ['op', 'wake:list', '{"kind":"due-time"}'];
const SWITCH = ['schedule', 'on', 'tool:x', 'daily'];

/** A fake door that answers every call with what it was asked; every request body is kept. */
const run = argv => {
  const asked = [];
  const result = main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'example-pin-route-')) }),
    fetchImpl: async (url, init) => {
      asked.push(init.body);
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { [settings.engine.account_meta]: { account_id: 'acct' } }, serverInfo: {}, capabilities: { tools: {} } } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { asked: body.params?.arguments }, content: [] } });
    },
    wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  return { asked, result };
};

/** The arguments of each call tool request sent, in order: { method, request_key, input, pins? }. */
const envelopes = asked => asked.map(body => JSON.parse(body)).filter(body => body.params?.arguments).map(body => body.params.arguments);

test('op --pin A --pin B sends pins ["A","B"] beside method, request_key and input, and a comma list keeps its order too', async () => {
  const { asked, result } = run([...WRITE, '--pin', 'mac-a', '--pin', 'mac_b', '--request-key', 'k-1']);
  await result;
  const [sent] = envelopes(asked);
  assert.deepEqual(sent.pins, ['mac-a', 'mac_b']);
  assert.deepEqual(sent.input, { tool: 'tool:x', id: 'daily', on: false });
  assert.deepEqual(Object.keys(sent).sort(), ['input', 'method', 'pins', 'request_key']);

  const listed = run([...READ, '--pin', 'mac-a,mac_b', '--pin', 'third', '--dry-run', '--request-key', 'k-2']);
  assert.deepEqual(JSON.parse(await listed.result), { method: 'wake:list', request_key: 'k-2', pins: ['mac-a', 'mac_b', 'third'], input: { kind: 'due-time' } });
  assert.equal(listed.asked.length, 0, 'a dry run sends nothing');
});

test('schedule on TOOL ID --pin A sends the pins with the switch, and schedule list sends them with the list', async () => {
  const { asked, result } = run([...SWITCH, '--pin', 'mac-a', '--request-key', 'k-3']);
  await result;
  const switches = envelopes(asked).filter(sent => sent.method === 'wake:switch');
  assert.deepEqual(switches.map(sent => [sent.input, sent.pins]), [[{ tool: 'tool:x', id: 'daily', on: true }, ['mac-a']]]);

  const listing = run(['schedule', 'list', '--pin', 'mac-a']);
  await listing.result;
  assert.deepEqual(envelopes(listing.asked).map(sent => [sent.method, sent.pins]), [['wake:list', ['mac-a']]]);
});

test('a call with no --pin sends the same envelope as before: exactly method, request_key and input, and no pins', async () => {
  const { asked, result } = run([...READ, '--request-key', 'k-4']);
  await result;
  const [sent] = envelopes(asked);
  assert.deepEqual(Object.keys(sent).sort(), ['input', 'method', 'request_key']);
  assert.deepEqual(sent.input, { kind: 'due-time' });

  const scheduled = run(['schedule', 'list']);
  await scheduled.result;
  assert.deepEqual(Object.keys(envelopes(scheduled.asked)[0]).sort(), ['input', 'method', 'request_key']);
});

test('a --pin the engine would refuse, or more than 64 of them, is refused before anything is sent', async () => {
  const refusals = [
    [...WRITE, '--pin', 'bad id'],
    [...WRITE, '--pin', 'mac-a,mac.b'],
    [...WRITE, '--pin='],
    [...WRITE, '--pin', 'a'.repeat(129)],
    [...SWITCH, '--pin', 'mac/a'],
    [...WRITE, ...Array.from({ length: 65 }, (_, at) => ['--pin', `mac-${at}`]).flat()],
  ];
  for (const argv of refusals) {
    const { asked, result } = run(argv);
    await assert.rejects(result, error => error instanceof CommandError && error.status === 2, argv.join(' '));
    assert.equal(asked.length, 0, argv.join(' '));
  }
  await assert.rejects(run([...WRITE, '--pin', 'bad id']).result, /--pin names a computer by its id/);
  await assert.rejects(run([...WRITE, ...Array.from({ length: 65 }, (_, at) => ['--pin', `mac-${at}`]).flat()]).result, /at most 64 computers; this names 65/);
});

test('64 pins and a 128-character id are the most the engine takes, and both are sent', async () => {
  const most = Array.from({ length: settings.engine.pins.most }, (_, at) => `mac-${at}`);
  const full = run([...READ, '--pin', most.join(','), '--request-key', 'k-5']);
  await full.result;
  assert.deepEqual(envelopes(full.asked)[0].pins, most);

  const longest = 'a'.repeat(128);
  const named = run([...READ, '--pin', longest, '--request-key', 'k-6']);
  await named.result;
  assert.deepEqual(envelopes(named.asked)[0].pins, [longest]);
});
