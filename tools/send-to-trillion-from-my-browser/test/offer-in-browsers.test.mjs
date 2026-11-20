// test/offer-in-browsers.test.mjs: extension/native-host/offer-in-browsers.mjs over a made-up home folder.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerInBrowsers } from '../native-host/offer-in-browsers.mjs';

const settings = {
  offers: [{ id: 'send', extension_id: 'abc', update_url: 'https://store.example/update' }],
  browsers: [
    { id: 'one', app: '~/Apps/One.app', profiles: '~/Support/One', offers_from: 'External Extensions' },
    { id: 'two', app: '~/Apps/Two.app', profiles: '~/Support/Two', offers_from: 'External Extensions' },
    { id: 'gone', app: '~/Apps/Gone.app', profiles: '~/Support/Gone', offers_from: 'External Extensions' },
  ],
};

test('offers each extension once in each installed browser that does not hold it', () => {
  const home = tempFolder(join(tmpdir(), 'offer-in-browsers-'));
  try {
    mkdirSync(join(home, 'Apps/One.app'), { recursive: true });
    mkdirSync(join(home, 'Apps/Two.app'), { recursive: true });
    mkdirSync(join(home, 'Support/Two/Profile 1/Extensions/abc'), { recursive: true });
    const stateFile = join(home, 'state/offered.json');

    assert.deepEqual(offerInBrowsers({ settings, home, stateFile }), [{ browser: 'one', offer: 'send' }]);
    const offered = join(home, 'Support/One/External Extensions/abc.json');
    assert.deepEqual(JSON.parse(readFileSync(offered, 'utf8')), { external_update_url: 'https://store.example/update' });
    assert.equal(existsSync(join(home, 'Support/Two/External Extensions/abc.json')), false, 'a browser holding it is left alone');
    assert.equal(existsSync(join(home, 'Support/Gone')), false, 'a browser not installed is passed over');

    // Turned down: the browser removed the offer file, and it is never made again.
    rmSync(offered);
    assert.deepEqual(offerInBrowsers({ settings, home, stateFile }), []);
    assert.equal(existsSync(offered), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('every offer file is in the install ledger, withdrawing removes exactly those, and a changed file is left', async () => {
  const { withdrawOffers } = await import('../native-host/offer-in-browsers.mjs');
  const home = tempFolder(join(tmpdir(), 'offer-ledger-'));
  try {
    mkdirSync(join(home, 'Apps/One.app'), { recursive: true });
    mkdirSync(join(home, 'Apps/Two.app'), { recursive: true });
    const stateFile = join(home, 'state/offered.json');
    offerInBrowsers({ settings, home, stateFile });
    const ledger = JSON.parse(readFileSync(stateFile, 'utf8')).ledger;
    console.log('READBACK ledger', JSON.stringify(ledger.map(({ path, owner, content }) => ({ path: path.replace(home, '~'), owner, content: content.slice(0, 12) }))));
    assert.equal(ledger.length, 2);
    const two = join(home, 'Support/Two/External Extensions/abc.json');
    writeFileSync(two, '{"person":"edited"}');
    const outcome = withdrawOffers({ stateFile });
    console.log('READBACK withdraw', JSON.stringify({ removed: outcome.removed.map(p => p.replace(home, '~')), changed: outcome.changed.map(p => p.replace(home, '~')) }));
    assert.equal(outcome.removed.length, 1);
    assert.deepEqual(outcome.changed, [two]);
    assert.equal(existsSync(join(home, 'Support/One/External Extensions/abc.json')), false);
    assert.equal(readFileSync(two, 'utf8'), '{"person":"edited"}');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).ledger.length, 1);
    writeFileSync(stateFile, '{ broken');
    assert.throws(() => withdrawOffers({ stateFile }), /nothing was written/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('relative native-host launcher paths resolve inside each account home', async () => {
  const { placeNativeHosts } = await import('../native-host/offer-in-browsers.mjs');
  const root = tempFolder(join(tmpdir(), 'native-host-home-'));
  const home = join(root, 'account-home');
  const otherHome = join(root, 'other-account-home');
  try {
    const app = join(home, 'Apps/One.app');
    mkdirSync(app, { recursive: true });
    const nativeSettings = {
      ...settings,
      native_host_launchers: '.trillion/computer-sources/native-hosts',
      native_hosts: [{ name: 'test.host', description: 'test', entry: 'browser-native-host.mjs', offers: ['send'] }],
      browsers: [{ ...settings.browsers[0], app, profiles: '~/Support/One', native_hosts_from: 'NativeMessagingHosts' }],
    };
    const state = { ledger: [] };
    const placed = placeNativeHosts({ settings: nativeSettings, home, runtime: '/node', state });
    const launcher = join(home, '.trillion/computer-sources/native-hosts/test.host');
    const manifest = join(home, 'Support/One/NativeMessagingHosts/test.host.json');
    assert.deepEqual(placed, [{ browser: 'one', host: 'test.host', state: 'placed' }]);
    assert.equal(existsSync(launcher), true, 'launcher is rooted under the account home');
    assert.equal(existsSync(manifest), true, 'browser manifest is rooted under the account home');
    assert.equal(existsSync(join(otherHome, '.trillion/computer-sources/native-hosts/test.host')), false, 'another account home receives no launcher');
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).allowed_origins, ['chrome-extension://abc/']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
