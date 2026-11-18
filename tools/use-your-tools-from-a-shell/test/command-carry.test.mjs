// Carrying this computer after login (command.json `carry`): only a computer that runs its own engine and came from a site
// is carried; its key is made once and kept; the carrier asks the site's meeting point with this program, never with an address
// kept here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { carrierKeyStore, carryThisComputer, speakFor } from '../do-work/command.mjs';
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
