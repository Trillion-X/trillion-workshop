// Carrying this computer after login (command.json `carry`): only a computer that runs its own engine and came from a site
// is carried; its key is made once and kept; the carrier asks the site's meeting point with this program, never with an address
// kept here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { carrierKeyStore, carryThisComputer, haveOf, heldDoors, offersHere, routeOf, speakFor } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

speakFor({ cli: 'example', site_name: 'Example' });

const homeWith = engine => {
  const home = mkdtempSync(join(tmpdir(), 'carry-home-'));
  if (engine) {
    const file = join(home, '.config/example/computer/computer.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(engine));
  }
  return home;
};
const fakeCarrier = made => ({
  WAYS: [{ id: settings.carry.way }],
  makeKey: () => { made.push(1); return { private: 'PRIVATE KEY TEXT', public: 'ssh-ed25519 AAAAPUBLIC carrier' }; },
  installCarrier: (config, state) => ({ config, state }),
});
const context = site => ({ state: { site: () => site } });

test('a computer with its own engine is carried to its site, with a key made once and kept only where keys are kept', async () => {
  const home = homeWith({ listen: '127.0.0.1:8788' });
  const made = [];
  const deps = { home, platform: 'linux', load: async () => fakeCarrier(made), program: ['/usr/bin/node', '/p/command.mjs'] };
  const { config, state } = await carryThisComputer(context('https://site.example.com'), deps);
  assert.equal(state, join(home, '.example/cli/carrier'));
  assert.equal(config.label, 'example-carrier');
  assert.equal(config.local_port, 8788);
  assert.deepEqual(config.relay_host, { id: 'site', hostname: 'site.example.com' });
  assert.match(config.computer_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(config.credential_command, ['/usr/bin/node', '/p/command.mjs', 'carrier-key']);
  assert.deepEqual(config.announce.argv.slice(0, 8), ['/usr/bin/node', '/p/command.mjs', 'op', '--origin', 'https://site.example.com', '--address', '@meeting', 'computers:announce']);
  assert.match(config.announce.argv[8], /"carried": \{carried\}/);
  assert.equal(config.values.public_key, 'ssh-ed25519 AAAAPUBLIC carrier');
  assert.ok(!JSON.stringify(config).includes('PRIVATE KEY TEXT'), 'the private key is never in the carrier config');
  const keyFile = join(home, '.example/cli/carrier/key');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!readFileSync(keyFile, 'utf8').includes('PRIVATE KEY TEXT'), 'kept encoded, as the sign-in is');
  assert.equal(carrierKeyStore({ home, platform: 'linux' }).read().private, 'PRIVATE KEY TEXT');
  const again = await carryThisComputer(context('https://site.example.com'), deps);
  assert.equal(made.length, 1, 'the key is made once');
  assert.equal(again.config.computer_id, config.computer_id, 'the same computer keeps its id');
});

test('a computer with no engine, no site or no carrier is not carried', async () => {
  const made = [];
  const load = async () => fakeCarrier(made);
  assert.equal(await carryThisComputer(context('https://site.example.com'), { home: homeWith(null), platform: 'linux', load }), null);
  assert.equal(await carryThisComputer(context(null), { home: homeWith({ listen: '127.0.0.1:8788' }), platform: 'linux', load }), null);
  assert.equal(await carryThisComputer(context('https://site.example.com'), { home: homeWith({ listen: '127.0.0.1:8788' }), platform: 'linux', load: async () => null }), null);
  assert.equal(made.length, 0);
});

test('the carrier runs the program as it was invoked, so it signs in under the same command name', async () => {
  const home = homeWith({ listen: '127.0.0.1:8788' });
  const invoked = process.argv[1];
  process.argv[1] = '/home/someone/.local/bin/example';
  try {
    const { config } = await carryThisComputer(context('https://site.example.com'), { home, platform: 'linux', load: async () => fakeCarrier([]) });
    assert.deepEqual(config.credential_command, [process.execPath, '/home/someone/.local/bin/example', 'carrier-key']);
    assert.equal(config.announce.argv[1], '/home/someone/.local/bin/example', 'never the program file under its own name (command.mjs)');
  } finally { process.argv[1] = invoked; }
});

test('the site is filled into every part of the settings, so no part a person or an AI reads keeps a raw {cli}', () => {
  const text = JSON.stringify(settings);
  for (const token of ['{cli}', '{CLI}', '{site_name}']) assert.ok(!text.includes(token), `a part still holds ${token}`);
  assert.match(settings.connection.recipes.find(row => row.id === 'cli').template, /^example setup/);
});

test('the announcement carries the doors the engine report names and its label, the way the carrier fills and sends it', async () => {
  const home = homeWith({ listen: '127.0.0.1:8788', report: { local_ports: { gpu: 9001, browser: 9002 }, label: 'A Mac' } });
  const { config } = await carryThisComputer(context('https://site.example.com'), { home, platform: 'linux', load: async () => fakeCarrier([]), program: ['/usr/bin/node', '/p/command.mjs'] });
  const expected = { doors: [{ name: 'gpu', port: 9001 }, { name: 'browser', port: 9002 }], label: 'A Mac' };
  assert.deepEqual(JSON.parse(config.values.have), expected);
  const { fill } = await import('../do-work/packs/tools/start-a-computer/do-work/fill-fields.mjs');
  const { valuesFor } = await import('../do-work/packs/tools/carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs');
  const input = config.announce.argv.map(part => fill(part, { ...valuesFor(config), carried: true }, 'announce')).at(-1);
  assert.deepEqual(JSON.parse(input).have, expected);
  assert.equal(JSON.parse(input).carried, true);
});

test('a computer that reports no doors still sends a have with doors, and a name or label the engine refuses is not sent', () => {
  assert.deepEqual(haveOf(undefined), { doors: [] });
  assert.deepEqual(haveOf({ local_ports: { 'Bad Name': 9001, gpu: 9002, zero: 0 }, label: 'two\u0007' }), { doors: [{ name: 'gpu', port: 9002 }] });
});

test('a name reported with two different ports is not sent as held; the same name and port twice is held once', () => {
  assert.deepEqual(heldDoors([['gpu', 9001], ['gpu', 9002], ['browser', 9003], ['browser', 9003]]), [{ name: 'browser', port: 9003 }]);
  assert.deepEqual(haveOf({ local_ports: { gpu: 9001 } }), { doors: [{ name: 'gpu', port: 9001 }] });
});

test('a have says what the engine offers when it says, and never an id the meeting point would refuse', async () => {
  assert.deepEqual(haveOf({ local_ports: {} }, ['use-git-in-a-folder', 'read-a-folder', 'read-a-folder']), { doors: [], offers: ['read-a-folder', 'use-git-in-a-folder'] });
  assert.deepEqual(haveOf({ local_ports: {} }, []), { doors: [], offers: [] }, 'offers nothing is said');
  assert.deepEqual(haveOf({ local_ports: {} }, undefined), { doors: [] }, 'not known is not said');
  assert.deepEqual(haveOf({ local_ports: {} }, ['Not An Id']), { doors: [] });
  const answering = offers => async () => ({ json: async () => ({ persons: 1, offers }) });
  assert.deepEqual(await offersHere('127.0.0.1:1', { fetchImpl: answering(['use-git-in-a-folder']) }), ['use-git-in-a-folder']);
  assert.equal(await offersHere('127.0.0.1:1', { fetchImpl: answering(undefined) }), undefined, 'an older engine says nothing');
  assert.equal(await offersHere('127.0.0.1:1', { fetchImpl: async () => { throw new Error('refused'); } }), undefined);
});

test('a call goes with its route when its row names a door or a computer capability, and with none otherwise', async () => {
  const client = need => ({ op: async () => ({ run: { need } }) });
  assert.deepEqual(await routeOf(client({ local_doors: [], capabilities: ['use-git-in-a-folder'] }), 'tool:x'), { need: { local_doors: [], capabilities: ['use-git-in-a-folder'] } });
  assert.deepEqual(await routeOf(client({ local_doors: [{ name: 'gpu', required: true }] }), 'tool:x'), { need: { local_doors: [{ name: 'gpu', required: true }] } });
  assert.deepEqual(await routeOf(client({ local_doors: [] }), 'tool:x'), {});
  assert.deepEqual(await routeOf(client(undefined), 'tool:x'), {});
});
