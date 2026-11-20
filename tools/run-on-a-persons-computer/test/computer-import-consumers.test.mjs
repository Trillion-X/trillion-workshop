// Current computer consumers over synthetic files/profiles and injected providers. No real account, Keychain,
// network, browser or native app is contacted; the actual imported owners and file cleanup remain exercised.
const toolsFolder = import.meta.dirname.split('/test')[0].replace(/[^/]+$/, '');
const runtime = { moduleURL: specifier => `file://${toolsFolder}${specifier.slice('tools/'.length)}` };
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const runtimeImport1 = await import(runtime.moduleURL("tools/run-on-a-persons-computer/send-opened-files.mjs"));
const { openedInput, sendOpenedFiles } = runtimeImport1;
const runtimeImport2 = await import(runtime.moduleURL("tools/run-on-a-persons-computer/follow-presence.mjs"));
const { followPresence, followSettings } = runtimeImport2;
const runtimeImport3 = await import(runtime.moduleURL("tools/run-on-a-persons-computer/carry-connections.mjs"));
const { makeCarrier } = runtimeImport3;
const runtimeImport4 = await import(runtime.moduleURL("tools/browse-and-upload-my-files/do-work/content-chunks.mjs"));
const { loadChunking } = runtimeImport4;

function folder(t) {
  const home = tempFolder(join(tmpdir(), 'computer-import-consumers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('native opened-file packets retain the complete ordered vector and refuse mismatched or unchecked paths', () => {
  const files = Array.from({ length: 1000 }, (_, n) => ({ file: `/synthetic/folder-${n}/same.txt` }));
  const key = 'synthetic-test-key';
  assert.deepEqual(openedInput(`${key}\n${JSON.stringify({ files })}`, null), { key, files });
  const pair = files.slice(0, 2), paths = pair.map(row => row.file);
  assert.deepEqual(openedInput(`${key}\n${JSON.stringify({ files: pair })}`, paths), { key, files: pair });
  assert.throws(() => openedInput(`${key}\n${JSON.stringify({ files: [...pair].reverse() })}`, paths), /could not be checked/);
  for (const supplied of [[], [{ file: 'relative.txt' }], [{ file: '/synthetic/zero\0byte' }], ['unchecked']])
    assert.throws(() => openedInput(`${key}\n${JSON.stringify({ files: supplied })}`, null), /could not be checked/);
  assert.throws(() => openedInput('\n', null), /Sign in/);
  assert.throws(() => openedInput(key, null), /could not be checked/);
});

test('opened files use real file sources and published chunking, keep duplicate names distinct and close each source', async t => {
  const home = folder(t), files = ['one', 'two'].map((name, n) => {
    const directory = join(home, name); mkdirSync(directory);
    const file = join(directory, 'same.txt'); writeFileSync(file, n ? 'second file' : 'first file'); return file;
  });
  const sources = [], sent = [], client = {};
  const answer = await sendOpenedFiles({ client, chunking: loadChunking, folder: '/Opened/', files,
    mediaType: async () => 'text/plain', send: async request => {
      assert.equal(request.client, client); assert.ok(request.chunking);
      sources.push(request.source);
      sent.push([request.name, Buffer.from(await request.source.readAt(0, request.source.size)).toString(), request.mediaType]);
      return { identity: `synthetic-accepted-${sources.length}`, state: 'kept' };
    } });
  assert.deepEqual(sent, [['/Opened/same.txt', 'first file', 'text/plain'], ['/Opened/same (2).txt', 'second file', 'text/plain']]);
  assert.deepEqual(answer.kept.map(row => [row.name, row.identity, row.state]), [
    ['/Opened/same.txt', 'synthetic-accepted-1', 'kept'], ['/Opened/same (2).txt', 'synthetic-accepted-2', 'kept'],
  ]);
  assert.deepEqual(answer.refused, []);
  for (const source of sources) await assert.rejects(source.readAt(0, 1), { code: 'EBADF' });
});

test('an opened-file refusal and cleanup failure cannot replace a kept result or prevent the next send', async () => {
  const closed = [], opened = [], sent = [];
  const answer = await sendOpenedFiles({ client: {}, chunking: {}, folder: '/Opened',
    files: ['/synthetic/one/same.txt', '/synthetic/two/same.txt', 'relative.txt'], mediaType: () => 'text/plain',
    open: async file => { opened.push(file); return { close: async () => { closed.push(file); throw new Error('synthetic cleanup failure'); } }; },
    send: async ({ name }) => { sent.push(name); if (sent.length === 1) throw new Error('synthetic send refusal'); return { identity: 'synthetic-kept', state: 'kept' }; },
  });
  assert.deepEqual(opened, ['/synthetic/one/same.txt', '/synthetic/two/same.txt']); assert.deepEqual(closed, opened);
  assert.deepEqual(sent, ['/Opened/same.txt', '/Opened/same (2).txt']);
  assert.deepEqual(answer.kept, [{ name: '/Opened/same (2).txt', identity: 'synthetic-kept', state: 'kept' }]);
  assert.deepEqual(answer.refused, [
    { file: 'same.txt', why: 'synthetic send refusal' }, { file: 'relative.txt', why: 'The file to open could not be checked.' },
  ]);
});

test('browser presence follows the shared extension reader, withdraws only unchanged files and preserves corrupt state', t => {
  for (const changedByOwner of [false, true]) {
    const home = folder(t), extensionId = 'a'.repeat(32), extension = join(home, 'profiles/Default/Extensions', extensionId);
    const app = join(home, 'Applications/Synthetic.app'), profiles = join(home, 'profiles');
    mkdirSync(extension, { recursive: true }); mkdirSync(app, { recursive: true });
    const settings = { ...followSettings(),
      browsers: [{ id: 'synthetic', app, profiles, hosts_in: 'NativeMessagingHosts' }],
      hosts: [{ id: 'fixture', name: 'synthetic.native.host', description: 'Synthetic host', extension_id: extensionId, path: join(home, 'synthetic-host') }],
    };
    const stateFile = join(home, 'presence-state.json'), file = join(profiles, 'NativeMessagingHosts/synthetic.native.host.json');
    const pass = () => followPresence({ home, settings, stateFile });
    assert.deepEqual(pass(), { wrote: ['synthetic:fixture'], withdrew: [], changed: [] });
    const bytes = readFileSync(file, 'utf8'), manifest = JSON.parse(bytes);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]); assert.equal(manifest.path, settings.hosts[0].path);
    assert.deepEqual(pass(), { wrote: [], withdrew: [], changed: [] });
    if (changedByOwner) writeFileSync(file, `${bytes}\nsynthetic owner edit\n`);
    rmSync(extension, { recursive: true });
    assert.deepEqual(pass(), changedByOwner ? { wrote: [], withdrew: [], changed: [file] } : { wrote: [], withdrew: ['synthetic:fixture'], changed: [] });
    if (changedByOwner) assert.equal(readFileSync(file, 'utf8'), `${bytes}\nsynthetic owner edit\n`);
    else { assert.throws(() => readFileSync(file), { code: 'ENOENT' }); assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).ledger, []); }
    writeFileSync(stateFile, '{unreadable state'); assert.deepEqual(pass(), { wrote: [], withdrew: [], changed: [] });
    assert.equal(readFileSync(stateFile, 'utf8'), '{unreadable state');
  }
});

test('the carrier publishes once, renews presence and never repeats cached sends or dispatches inherited/stale/unavailable verbs', async () => {
  const settings = JSON.parse(readFileSync(new URL(runtime.moduleURL('tools/run-on-a-persons-computer/carry-connections.json')), 'utf8'));
  const saved = new Map(), calls = [], sent = []; let carried = true;
  const module = { start: async () => ({ carried: true }), carried: () => carried,
    send: async input => { sent.push(input); return { sent: true, id: 'synthetic-message' }; } };
  const now = Date.parse('2026-11-08T06:00:00Z');
  const carrier = makeCarrier({ settings, connections: new Map([['synthetic', { row: { label: 'Synthetic' }, module }]]),
    call: async (route, input) => { calls.push([route, input]); return {}; }, computer: 'Synthetic Mac',
    kept: { get: id => saved.get(id), put: (id, value) => saved.set(id, value) }, now: () => now,
  });
  await carrier.publish(); await carrier.publish();
  assert.deepEqual(calls.map(([route]) => route), ['/agents/publish', '/agents/presence', '/agents/presence']);
  assert.deepEqual(calls[0][1].skills.map(row => row.id), ['connection:synthetic']);
  const job = { handoff_id: 'synthetic:send', handed_at: new Date(now).toISOString(), input: { connection: 'synthetic', verb: 'send', text: 'Synthetic words' } };
  assert.deepEqual(await carrier.run(job), { sent: true, id: 'synthetic-message' }); assert.deepEqual(await carrier.run(job), { sent: true, id: 'synthetic-message' });
  assert.deepEqual(sent, [{ text: 'Synthetic words' }]);
  const refused = extra => carrier.run({ ...job, handoff_id: 'synthetic:refused', ...extra });
  assert.equal((await refused({ input: { connection: 'synthetic', verb: 'constructor' } })).sent, false);
  assert.equal((await refused({ handed_at: new Date(now - 11 * 60_000).toISOString() })).sent, false);
  carried = false; assert.equal((await refused({})).sent, false); assert.equal(sent.length, 1);
});
