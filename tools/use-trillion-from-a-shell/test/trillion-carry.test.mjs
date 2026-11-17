// Carrying this computer after login (trillion.json `carry`): only a computer that runs its own engine and came from a site
// is carried; its key is made once and kept; the carrier asks the site's meeting point with this program, never with an address
// kept here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { carrierKeyStore, carryThisComputer, speakFor } from '../do-work/trillion.mjs';
import settings from '../do-work/trillion.json' with { type: 'json' };

speakFor({ cli: 'trillion', brand: 'Trillion' });

const homeWith = engine => {
  const home = mkdtempSync(join(tmpdir(), 'carry-home-'));
  if (engine) {
    const file = join(home, '.config/trillion/computer/computer.json');
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
  const deps = { home, platform: 'linux', load: async () => fakeCarrier(made), program: ['/usr/bin/node', '/p/trillion.mjs'] };
  const { config, state } = await carryThisComputer(context('https://site.example.com'), deps);
  assert.equal(state, join(home, '.trillion/cli/carrier'));
  assert.equal(config.label, 'trillion-carrier');
  assert.equal(config.local_port, 8788);
  assert.deepEqual(config.relay_host, { id: 'site', hostname: 'site.example.com' });
  assert.match(config.computer_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(config.credential_command, ['/usr/bin/node', '/p/trillion.mjs', 'carrier-key']);
  assert.deepEqual(config.announce.argv.slice(0, 7), ['/usr/bin/node', '/p/trillion.mjs', 'op', '--origin', 'https://site.example.com', '@meeting', 'computers:announce']);
  assert.match(config.announce.argv[7], /"carried": \{carried\}/);
  assert.equal(config.values.public_key, 'ssh-ed25519 AAAAPUBLIC carrier');
  assert.ok(!JSON.stringify(config).includes('PRIVATE KEY TEXT'), 'the private key is never in the carrier config');
  const keyFile = join(home, '.trillion/cli/carrier/key');
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
