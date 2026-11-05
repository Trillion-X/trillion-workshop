// The Signal client rows: what signal-cli prints (test/fixtures/signal-cli-receive.jsonl, a made-up `-o json receive`
// output) folded into the `signal` pull's contract and kept through that pull, with signal-cli answered by a stand-in.
// Everyone and every id here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelopesToConversations, readEnvelopeLines } from '../read-data/signal-envelopes.mjs';
import { clientEnvironment, linkCode, linkedAccount, readSignalOnThisComputer, scrubbed } from '../do-work/signal-client.mjs';
import { assemble, readParts } from '../read-data/snapshot.mjs';
import { openDoor } from './service.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const SELF = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const GROUP = 'group:c2FtcGxlLWdyb3VwLWlkLW1hZGUtdXA=';
const PRINTED = readFileSync(new URL('./fixtures/signal-cli-receive.jsonl', import.meta.url), 'utf8');
const NOW = '2026-11-05T12:00:00Z';

// The fields README.md "What the Signal client must hand in" allows, and no others.
const CONVERSATION_FIELDS = new Set(['id', 'name', 'type', 'messages']);
const MESSAGE_FIELDS = new Set(['id', 'timestamp', 'from', 'body', 'editedTimestamp', 'type']);

/** A client folder signal-cli has linked (its data/accounts.json naming the account), or an empty one. */
function clientFolder({ linked = true } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'signal-client-'));
  if (linked) {
    mkdirSync(join(folder, 'data'));
    writeFileSync(join(folder, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ path: 'sample', environment: 'LIVE', uuid: SELF }], version: 2 }));
  }
  return folder;
}

/** A stand-in for signal-cli: answers each start from `answers` in turn and remembers its arguments. */
function standIn(...answers) {
  const calls = [];
  const spawnSync = (program, args, options) => { calls.push({ program, args, options }); return answers.shift() ?? { status: 0, stdout: '', stderr: '' }; };
  return { calls, spawnSync };
}

test('signal-cli envelopes fold into the pull\'s contract: groups by id and name, people by service id, own messages by self_id, edits on their message, calls kept', () => {
  const { envelopes, unreadable } = readEnvelopeLines(`${PRINTED}not json\n{"no":"envelope"}\n`);
  assert.equal(envelopes.length, 11);
  assert.equal(unreadable, 2);
  const { conversations, left_out } = envelopesToConversations(envelopes, SELF);
  assert.equal(left_out, 4, 'a receipt, typing, a reaction and a group change are not messages');
  assert.deepEqual(conversations, [
    { id: GROUP, type: 'group', name: 'Bakers', messages: [
      { id: `${B}:1700000000000`, timestamp: 1700000000000, from: B, type: 'normal', body: 'Rye is ready' },
      { id: `${SELF}:1700000001000`, timestamp: 1700000001000, from: SELF, type: 'normal', body: 'On my way' },
      { id: `${B}:1700000002000`, timestamp: 1700000002000, from: B, type: 'normal', body: 'Ten loaves, sliced', editedTimestamp: 1700000500000 },
    ] },
    { id: C, type: 'individual', name: 'Carol C', messages: [
      { id: `${C}:1700000004000`, timestamp: 1700000004000, from: C, type: 'normal', body: 'Are you open on Sunday?' },
      { id: `${SELF}:1700000005000`, timestamp: 1700000005000, from: SELF, type: 'normal', body: 'Yes, from nine' },
      { id: `${C}:1700000006000`, timestamp: 1700000006000, from: C, type: 'call_started' },
    ] },
  ]);
  for (const conversation of conversations) {
    assert.deepEqual(Object.keys(conversation).filter(key => !CONVERSATION_FIELDS.has(key)), []);
    for (const message of conversation.messages) assert.deepEqual(Object.keys(message).filter(key => !MESSAGE_FIELDS.has(key)), []);
  }
  assert.doesNotMatch(JSON.stringify(conversations), /sample-account|\+\d/, 'no phone number or account name is copied');
});

test('an edit seen before the message it edits keeps the edit; an older edit never replaces a later one', () => {
  const edit = (at, text) => ({ sourceUuid: B, timestamp: at, editMessage: { targetSentTimestamp: 100, dataMessage: { timestamp: at, message: text } } });
  const original = { sourceUuid: B, timestamp: 100, dataMessage: { timestamp: 100, message: 'first' } };
  const { conversations } = envelopesToConversations([edit(300, 'third'), original, edit(200, 'second')], SELF);
  assert.deepEqual(conversations[0].messages, [{ id: `${B}:100`, timestamp: 100, from: B, type: 'normal', body: 'third', editedTimestamp: 300 }]);
});

test('read: what signal-cli received is kept through the signal pull, from the kept folder, with only Java\'s proxy added to its environment', async () => {
  const opened = await openDoor();
  const folder = clientFolder();
  const client = standIn({ status: 0, stdout: PRINTED, stderr: '' });
  const done = await readSignalOnThisComputer({ input: { account: 'sample' }, client_folder: folder },
    { door: opened.door, now: () => NOW, spawnSync: client.spawnSync });
  assert.equal(done.status, 'pulled', done.said);
  assert.equal(done.self_id, SELF);
  assert.equal(done.new_messages, 6);
  assert.equal(done.received, 11);
  assert.equal(done.left_out, 4);
  assert.match(done.said, /4 envelopes were not a message/);
  assert.equal(client.calls.length, 1);
  const [{ program, args }] = client.calls;
  assert.equal(program, 'signal-cli', 'found by name on the PATH the engine gave the run');
  assert.deepEqual(args.slice(0, 5), ['--config', folder, '-o', 'json', 'receive']);
  assert.ok(args.includes('--ignore-attachments'));
  const snapshot = assemble('signal', 'sample', await readParts(opened.door, 'signal', 'sample'));
  assert.deepEqual(snapshot.threads.map(thread => [thread.title, thread.messages.length]), [['Bakers', 3], ['Carol C', 3]]);
  assert.equal(snapshot.self_id, SELF);
  assert.equal(existsSync(join(folder, 'trillion-pending.jsonl')), false, 'nothing is left to hand in again');
});

test('read: what arrived is written down first, so a run whose keeping failed hands it in again at the next run', async () => {
  const folder = clientFolder();
  const closed = new Proxy({}, { get() { throw new Error('the records door is not open'); } });
  await assert.rejects(readSignalOnThisComputer({ client_folder: folder }, { door: closed, now: () => NOW, spawnSync: standIn({ status: 0, stdout: PRINTED }).spawnSync }));
  assert.equal(readFileSync(join(folder, 'trillion-pending.jsonl'), 'utf8'), PRINTED, 'Signal hands a message over once; it is kept here');
  const opened = await openDoor();
  const done = await readSignalOnThisComputer({ client_folder: folder }, { door: opened.door, now: () => NOW, spawnSync: standIn({ status: 0, stdout: '' }).spawnSync });
  assert.equal(done.new_messages, 6, 'the next run, with nothing new received, keeps what the last one could not');
  assert.equal(existsSync(join(folder, 'trillion-pending.jsonl')), false);
});

test('read: not linked answers needs_link and starts nothing; a client that cannot start is unreachable and says why without a phone number', async () => {
  const opened = await openDoor();
  const unlinked = standIn();
  const done = await readSignalOnThisComputer({ client_folder: clientFolder({ linked: false }) }, { door: opened.door, spawnSync: unlinked.spawnSync });
  assert.equal(done.status, 'needs_link');
  assert.match(done.said, /tool:link-signal-on-this-computer/);
  assert.equal(unlinked.calls.length, 0);
  const failing = standIn({ status: 1, stdout: '', stderr: 'Account +15550100999 is not registered' });
  const down = await readSignalOnThisComputer({ client_folder: clientFolder() }, { door: opened.door, spawnSync: failing.spawnSync });
  assert.equal(down.status, 'unreachable');
  assert.doesNotMatch(down.said, /15550100999/);
  assert.equal(opened.calls.length, 0, 'nothing was written');
  await assert.rejects(readSignalOnThisComputer({ client_folder: 'relative/folder' }, {}), /absolute folder/);
});

test('the client environment points Java at the run\'s proxy, keeps the run\'s PATH, and adds nothing without a proxy', () => {
  const env = clientEnvironment({ PATH: '/kept/java/bin:/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:41234' });
  assert.equal(env.PATH, '/kept/java/bin:/usr/bin');
  assert.match(env.JAVA_TOOL_OPTIONS, /-Dhttps\.proxyHost=127\.0\.0\.1 -Dhttps\.proxyPort=41234/);
  assert.equal(clientEnvironment({ PATH: '/usr/bin' }).JAVA_TOOL_OPTIONS, undefined);
  assert.equal(scrubbed('call +447700900123 failed'), 'call +… failed');
  assert.equal(linkedAccount(clientFolder()), SELF);
  assert.equal(linkedAccount(clientFolder({ linked: false })), null);
});

test('link: the address signal-cli gives is shown as a QR code a page and a terminal can draw', () => {
  const code = linkCode('sgnl://linkdevice?uuid=c2FtcGxl&pub_key=a2V5');
  assert.equal(code.link, 'sgnl://linkdevice?uuid=c2FtcGxl&pub_key=a2V5');
  assert.match(code.qr_svg, /^<svg /);
  assert.ok(code.qr_text.split('\n').length > 10);
});

// The Java pins old trillion's java row carried (trillion-rust 62d1aa7b, dropped from the engine's table in #171),
// copied here as written so the rows' copy can never drift from them.
const JAVA = {
  'macos-aarch64': ['OpenJDK25U-jre_aarch64_mac_hotspot_25.0.5_8.tar.gz', '79bfaeedf4bbb12fbfb2272bc29b72405ff6e26fb1c2b7677f5a8d1ec9a25519', 'Contents/Home/bin/java'],
  'macos-x86_64': ['OpenJDK25U-jre_x64_mac_hotspot_25.0.5_8.tar.gz', 'e8f34155b0c809d47677675cc726c2f482148bd8153848e888533aedcb7e0ba0', 'Contents/Home/bin/java'],
  'linux-x86_64': ['OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz', 'c8c0ed9e529756257cab8c317a372a9de7d4e00b4ce794d295d5b2549bea5ecc', 'bin/java'],
  'linux-aarch64': ['OpenJDK25U-jre_aarch64_linux_hotspot_25.0.5_8.tar.gz', '69b9e5e2667493893c958591436abf3d7d6808c436ddff8a2c67578500af3afc', 'bin/java'],
};

test('both client rows run on this computer from node, keep one folder between runs, and declare signal-cli and the pinned Java themselves', () => {
  const client = ['tool:read-my-signal-messages-on-this-computer', 'tool:link-signal-on-this-computer']
    .map(id => rows.records.map(record => record.payload).find(row => row.id === id));
  for (const row of client) {
    const { invoke } = row;
    assert.equal(invoke.kind, 'computer', row.id);
    assert.deepEqual(invoke.capabilities, [], 'it needs no grant: no person step but the scan');
    assert.equal(invoke.kept_folder, true);
    assert.deepEqual(invoke.stdin.client_folder, { fill: { from: 'task', field: 'kept_folder' } });
    assert.equal(invoke.argv[0], 'node');
    assert.deepEqual(Object.keys(invoke.programs).sort(), ['java', 'signal-cli']);
    for (const [system, [file, blake3, executable]] of Object.entries(JAVA)) {
      assert.deepEqual(invoke.programs.java.fetch[system], { url: `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/${file}`,
        version: '25.0.5+8', blake3, executable, checked_against: `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/${file}.sha256.txt` }, system);
    }
    assert.deepEqual(invoke.programs.java.runtime_read_dirs, ['..']);
    const signal = invoke.programs['signal-cli'];
    for (const system of ['macos-aarch64', 'macos-x86_64', 'linux-x86_64']) {
      assert.deepEqual(signal.fetch[system], { url: 'https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.tar.gz', version: '0.14.9',
        blake3: '793393034d534bdb4cdfc8e3f212ac1c4271e4139ca5fff9ecc8531e2777ccb2', executable: 'bin/signal-cli',
        checked_against: 'https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.tar.gz.asc' }, system);
    }
    assert.match(signal.fetch['linux-aarch64'].unverified, /no linux aarch64 library/);
    assert.deepEqual(signal.runtime_read_dirs, ['..'], 'its jars beside its launcher are read');
    assert.deepEqual(invoke.programs, client[0].invoke.programs, 'both rows declare the same programs');
  }
  assert.ok(client[1].invoke.session, 'linking waits for the scan as a session whose output shows the code');
});
