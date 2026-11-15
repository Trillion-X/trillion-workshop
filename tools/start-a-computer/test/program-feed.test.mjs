// tools/start-a-computer/test/program-feed.test.mjs
//
// A unit that runs a program from a signed feed (`program_feed`, the public door's forwarder-feed.json) is behind when its
// releases folder's `current` is not the newest entry for the machine's target that one of the row's keys signed;
// applying the row puts that entry there (download checked by bytes and BLAKE3, unpacked, `current` moved by one rename)
// and restarts the unit, whose boot check asks with the Host its health row names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHostLayout, hostLayoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';
import { newSigningKey, publicKeyHex, signEntry } from 'trillion-workshop/tools/publish-an-engine-release/do-work/release-feed.mjs';

const key = newSigningKey(), stranger = newSigningKey();
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), FORGED = 'c'.repeat(40);
const TARGET = 'x86_64-unknown-linux-gnu';
const entry = (commit, sequence, by = key) => signEntry({ commit, sequence, target: TARGET, url: `https://feed.example.test/forwarder/${commit}/${TARGET}.tar.gz`, content: `1f:${'0'.repeat(64)}`, bytes: 1, urgent: false }, by);
const feed = { releases: [entry(OLD, 1), entry(NEW, 2), entry(FORGED, 3, stranger)] };
const fetchImpl = async url => {
  assert.equal(url, 'https://feed.example.test/forwarder-feed.json');
  return { ok: true, status: 200, json: async () => feed };
};
const door = {
  unit: 'example-door.service', template: 'serve-door', description: 'Example door', user: 'example-door', state: '/var/lib/example-door',
  releases: '/opt/example-door/releases', door_file: 'example-door', environment: ['DOOR_LISTEN=127.0.0.1:9445'],
  program_feed: { urls: ['https://feed.example.test/forwarder-feed.json'], public_keys: [publicKeyHex(key)] },
  health: { path: '/.well-known/oauth-protected-resource/mcp', status: 200, host: 'place.example.test' }, health_listen: '127.0.0.1:9445',
};
const layout = { caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' }, units: [door], unmanaged: [] };
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };

// A computer that runs the layout as rendered, whose door releases folder's `current` names `current`.
const computer = current => {
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.includes('uname -s')) return 'Linux x86_64\n';
    if (command.startsWith('readlink ')) return current ? `${current}\n` : '';
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands };
};

test('a door behind its signed feed is a difference, and one at the newest signed entry is not', async () => {
  const behind = computer(OLD);
  assert.deepEqual(await hostLayoutDifferences(machine, layout, behind.run, undefined, { fetchImpl }),
    [{ path: '/opt/example-door/releases/current', reason: `runs ${OLD}; its signed feed gives ${NEW}` }]);
  const none = computer('');
  assert.deepEqual(await hostLayoutDifferences(machine, layout, none.run, undefined, { fetchImpl }),
    [{ path: '/opt/example-door/releases/current', reason: `runs no program; its signed feed gives ${NEW}` }]);
  const current = computer(NEW);
  assert.deepEqual(await hostLayoutDifferences(machine, layout, current.run, undefined, { fetchImpl }), [], 'a newer entry another key signed is not followed');
});

test('applying moves the door to the newest signed entry, checked and unpacked as its user, then restarts and asks it with its Host', async () => {
  const { run, commands } = computer(OLD);
  const answer = await applyHostLayout(machine, layout, run, undefined, {}, { fetchImpl });
  assert.deepEqual(answer.released, [{ unit: 'example-door.service', from: OLD, commit: NEW }]);
  assert.deepEqual(answer.restarted, ['example-door.service']);
  const placed = commands.find(({ command }) => command.startsWith("runuser -u 'example-door' -- sh -c"));
  assert.ok(placed, 'the program is placed as the unit\'s own user');
  const script = placed.command.replaceAll("'\\''", "'");
  assert.match(script, /curl -fsSL --max-time 900 -o '\/opt\/example-door\/releases\/b{40}\.tar\.gz\.part' 'https:\/\/feed\.example\.test\/forwarder\/b{40}\//);
  assert.match(script, /b3sum --no-names/);
  assert.match(script, /ln -sfn 'b{40}' '\/opt\/example-door\/releases\/current\.new' && mv -T '\/opt\/example-door\/releases\/current\.new' '\/opt\/example-door\/releases\/current'/);
  assert.equal(JSON.parse(placed.input).commit, NEW, 'the signed entry is the release.json');
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-door.service'"));
  assert.ok(commands.some(({ command }) => command.includes("-H 'Host: place.example.test' 'http://127.0.0.1:9445/.well-known/oauth-protected-resource/mcp'")));
});

test('a door already at the newest signed entry gets nothing placed and is not restarted', async () => {
  const { run, commands } = computer(NEW);
  assert.deepEqual(await applyHostLayout(machine, layout, run, undefined, {}, { fetchImpl }), { written: [], restarted: [] });
  assert.equal(commands.filter(({ command }) => command.startsWith('runuser') || command.startsWith('systemctl')).length, 0);
});
