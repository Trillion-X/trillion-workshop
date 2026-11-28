// tools/use-your-tools-from-a-shell/test/command-local-door.test.mjs
//
// Where the command finds this computer's local door, and that a call says which door answered it. The door is declared by the
// engine's own config (`listen`, written by the app on every launch) or by the app's bundle declaration, found from the app
// the site names (`mac_app`), never from the node that happens to run the command (a shell's own node is not the app's).
// A computer that declares none says so on stderr, with every place looked at, and never goes to another door unsaid.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { doorFor, findLocalDoor, main, noLocalDoorWords, stateOf, speakFor } from '../do-work/command.mjs';
import { localDoorAddress } from '../do-work/local-door.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

speakFor({ cli: 'example', site_name: 'Example' });

const folder = () => tempFolder(join(tmpdir(), 'example-local-door-'));
const SYSTEM_NODE = '/usr/local/bin/node';
const declarationOf = port => JSON.stringify({ local_runtime: { computer: { listen_host: '127.0.0.1', port } } });
const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
/** Rules whose app lives in `app` (as command.json `mac_app` names it) and whose engine config lives under `home`. */
const rulesIn = (app, home) => ({ ...settings, mac_app: app, computer_config_files: [join(home, 'computer.json')] });
const appDeclaration = app => join(app, 'Contents', 'Resources', 'computer-reader.json');

test('the declaration is found from the app the site names when the running node is not the app\'s', () => {
  const root = folder();
  const app = join(root, 'Example.app');
  write(appDeclaration(app), declarationOf(8788));
  const found = findLocalDoor({ rules: rulesIn(app, join(root, 'home')), home: root, execPath: SYSTEM_NODE });
  assert.equal(found, 'http://127.0.0.1:8788/mcp', 'a system node found the app\'s door through mac_app');
});

test('the engine config the app writes names the door, and wins over a declaration of another port', () => {
  const root = folder();
  const app = join(root, 'Example.app');
  write(appDeclaration(app), declarationOf(8788));
  write(join(root, 'home', 'computer.json'), JSON.stringify({ listen: '127.0.0.1:9911' }));
  assert.equal(findLocalDoor({ rules: rulesIn(app, join(root, 'home')), home: root, execPath: SYSTEM_NODE }), 'http://127.0.0.1:9911/mcp');
  write(join(root, 'home', 'computer.json'), JSON.stringify({ listen: '0.0.0.0:9911' }));
  assert.equal(findLocalDoor({ rules: rulesIn(app, join(root, 'home')), home: root, execPath: SYSTEM_NODE }), 'http://127.0.0.1:8788/mcp', 'a listen address that is not loopback is not a door');
});

test('an app installed anywhere else is found from its own node when that is the one running', () => {
  const root = folder();
  const elsewhere = join(root, 'Elsewhere.app');
  write(appDeclaration(elsewhere), declarationOf(8801));
  const rules = rulesIn(join(root, 'Example.app'), join(root, 'home'));
  assert.equal(findLocalDoor({ rules, home: root, execPath: join(elsewhere, 'Contents', 'MacOS', 'node') }), 'http://127.0.0.1:8801/mcp');
  assert.equal(findLocalDoor({ rules, home: root, execPath: SYSTEM_NODE }), null, 'a node that is not an app\'s adds no place to look');
});

test('localDoorAddress refuses a port or host that is not this computer\'s loopback, and names every place it looked', () => {
  for (const port of [80, 70000, 'x', null]) {
    assert.throws(() => localDoorAddress({ runtimes: ['/App/Contents/MacOS/node'], read: () => declarationOf(port) }), /installed Mac app/);
  }
  assert.throws(() => localDoorAddress({ runtimes: ['/App/Contents/MacOS/node'], configs: ['/cfg/computer.json'], read: () => { throw new Error('none'); } }),
    error => JSON.stringify(error.tried) === JSON.stringify(['/cfg/computer.json', '/App/Contents/Resources/computer-reader.json']));
});

test('no declaration gives the named line, with every file looked at and the door the call went to', () => {
  const root = folder();
  const rules = rulesIn(join(root, 'Example.app'), join(root, 'home'));
  assert.equal(findLocalDoor({ rules, home: root, execPath: SYSTEM_NODE }), null);
  const door = doorFor({ credential: { kind: 'sign-in', origin: 'https://example.test', resource: 'https://example.test/mcp' }, declared: 'https://example.test', localMcp: null });
  assert.equal(noLocalDoorWords(door, { rules, home: root, execPath: SYSTEM_NODE }), 'Example on this computer was not found, so this call went to Example.');
  assert.equal(noLocalDoorWords(door, { rules, home: root, execPath: SYSTEM_NODE, verbose: true }),
    `Example on this computer was not found, so this call went to Example. Looked for it at ${join(root, 'home', 'computer.json')}, ${appDeclaration(join(root, 'Example.app'))}; the door was https://example.test/mcp.`);
});

test('a pass made for the site this computer\'s app serves goes to the local door; a pass made for another site never does', () => {
  const local = 'http://127.0.0.1:8788/mcp';
  const own = doorFor({ credential: { kind: 'sign-in', origin: 'https://example.test', resource: 'https://example.test/mcp' }, declared: 'https://example.test', localMcp: local });
  assert.deepEqual([own.local, own.mcp], [true, local], 'a sign-in at the declared site\'s door goes to this computer\'s own engine');
  const other = doorFor({ credential: { kind: 'sign-in', origin: 'https://elsewhere.test', resource: 'https://elsewhere.test/mcp' }, declared: 'https://example.test', localMcp: local });
  assert.deepEqual([other.local, other.mcp], [false, 'https://elsewhere.test/mcp']);
  const none = doorFor({ credential: { kind: 'sign-in', origin: 'https://example.test', resource: 'https://example.test/mcp' }, declared: 'https://example.test', localMcp: null });
  assert.deepEqual([none.local, none.mcp], [false, 'https://example.test/mcp'], 'with no local door the sign-in goes where it was made');
});

/** A fake door that answers every call with { ran: true }. */
const fakeDoor = () => ({ fetchImpl: async (url, init) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { structuredContent: { ran: true }, content: [] } }) });
const grantAt = origin => ({ where: 'test sign-in', read: () => ({ access_token: 'pass', origin, resource: `${origin}/mcp`, scope: 'tools:*' }), write: () => {}, forget: () => {} });
/** A computer installed from https://example.test: its state folder holds the site file the install writes. */
const installedHome = () => {
  const home = folder();
  write(join(home, '.example', 'cli', 'site.json'), JSON.stringify({ origin: 'https://example.test', site_name: 'Example', cli: 'example' }));
  return home;
};
const seams = (said, extra = {}) => ({ env: { CLAUDECODE: '1' }, store: { read: () => null, where: 'none' }, grants: grantAt('https://example.test'),
  state: stateOf({ home: installedHome() }), fetchImpl: fakeDoor().fetchImpl, wait: async () => {}, agentSocket: () => null, computerName: 'Mac', model: null, place: () => ({}),
  say: text => said.push(text), ...extra });

test('a reply names the door that answered, and the computers it was pinned to', async () => {
  const local = { localDoor: () => 'http://127.0.0.1:8788/mcp' };
  const said = [];
  await main(['op', 'tools:read', '{}'], seams(said, local));
  assert.deepEqual(said, ['Answered by Example on this computer.']);
  const pinned = [];
  await main(['call', 'tool:x', '{}', '--pin', 'computer-a,computer-b'], seams(pinned, local));
  assert.deepEqual(pinned, ['Answered by Example on this computer. Pinned to computer computer-a, computer-b.']);
  const verbose = [];
  await main(['op', 'tools:read', '{}', '--verbose'], seams(verbose, local));
  assert.deepEqual(verbose, ['Answered by Example on this computer. The door was http://127.0.0.1:8788/mcp.']);
});

test('a call with no local door says so before the door that answered, and never goes there unsaid', async () => {
  const said = [];
  await main(['op', 'tools:read', '{}'], seams(said, { localDoor: () => null }));
  assert.deepEqual(said, ['Example on this computer was not found, so this call went to Example.', 'Answered by Example.']);
  const verbose = [];
  await main(['op', 'tools:read', '{}', '--verbose'], seams(verbose, { localDoor: () => null }));
  assert.match(verbose[0], /^Example on this computer was not found, so this call went to Example\. Looked for it at .+; the door was https:\/\/example\.test\/mcp\.$/);
  assert.equal(verbose[1], 'Answered by Example. The door was https://example.test/mcp.');
});

test('a door the person named is not a fall-through: no "not found" line, but the answer still names its door', async () => {
  const said = [];
  const key = `nm_${'cd'.repeat(16)}`;
  await main(['op', 'tools:read', '{}', '--origin', 'https://named.test'], seams(said, { localDoor: () => null, grants: { where: 'x', read: () => null, write() {}, forget() {} }, store: { read: () => key, where: 'test key' }, env: { CLAUDECODE: '1', EXAMPLE_KEY: key } }));
  assert.deepEqual(said, ['Answered by Example.']);
});
