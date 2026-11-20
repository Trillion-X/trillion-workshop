// tools/use-your-tools-from-a-shell/test/command-op-upload.test.mjs
//
// `example op ... --upload FILE` and `example call ... --upload FILE` send the call as one raw upload, the way the engine's door takes
// a file (trillion-rust src/mcp/upload.rs): the file's bytes are the body, sent as an octet stream, and the JSON-RPC message rides in
// the X-Call header as base64url. A call without the flag is the plain JSON body it always was. A file larger than one body may carry,
// a missing file and a flag with no file are refused before anything is sent. Synthetic data only.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, CommandError, speakFor, uploadOf, uploadDoorHere, engineClient } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => tempFolder(join(tmpdir(), 'example-op-upload-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const answered = { structuredContent: { version: 1 }, content: [] };

/** A fake door that keeps each request's content type, its X-Call message (decoded) and its body bytes. */
function fakeDoor() {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const type = init.headers['content-type'];
    const raw = type === 'application/octet-stream';
    const message = raw ? JSON.parse(Buffer.from(init.headers['x-call'], 'base64url').toString('utf8')) : JSON.parse(init.body);
    seen.push({ type, message, body: raw ? Buffer.from(init.body) : null });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: answered });
  };
  return { seen, fetchImpl };
}

const run = (argv, door) => main([...argv, '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const PIECE = '{"tool":"tool:files","call":{"name":"write_file_piece","arguments":{"upload_id":"u1","offset":0}}}';

test('op --upload sends the file as the body and the call in X-Call; without it the call is the JSON body', async () => {
  const folder = tempFolder(join(tmpdir(), 'example-upload-file-'));
  const file = join(folder, 'piece.bin');
  const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, at) => at % 251));
  writeFileSync(file, bytes);
  const door = fakeDoor();
  const output = await run(['op', 'tools:run', PIECE, '--upload', file], door);
  assert.match(output, /"version": 1/);
  const [sent] = door.seen;
  assert.equal(sent.type, 'application/octet-stream', 'a raw upload is an octet stream');
  assert.ok(sent.body.equals(bytes), 'the body is the file, byte for byte, larger than one 64 KiB session message');
  assert.equal(sent.message.method, 'tools/call');
  assert.equal(sent.message.params.arguments.method, 'tools:run');
  assert.deepEqual(sent.message.params.arguments.input, JSON.parse(PIECE), 'the call is the one a JSON request would carry');
  assert.ok(!JSON.stringify(sent.message).includes('byte_upload'), 'only the door names the spooled file');

  const plain = fakeDoor();
  await run(['op', 'tools:run', PIECE], plain);
  assert.equal(plain.seen[0].type, 'application/json', 'a call without --upload is unchanged');

  const called = fakeDoor();
  await run(['call', 'tool:files', '{"name":"write_file_piece"}', '--upload', file], called);
  assert.ok(called.seen.at(-1).body.equals(bytes), 'call takes --upload too');
});

test('a file too large for one body, a missing file and a flag with no file are refused before anything is sent', async () => {
  const folder = tempFolder(join(tmpdir(), 'example-upload-refused-'));
  const large = join(folder, 'large.bin');
  writeFileSync(large, Buffer.alloc(16));
  const small = { ...settings, direct_calls: { ...settings.direct_calls, upload_most_bytes: 8 } };
  assert.throws(() => uploadOf(large, small), error => error instanceof CommandError && error.status === 2 && /in pieces/.test(error.message));
  assert.throws(() => uploadOf(join(folder, 'absent.bin')), error => error instanceof CommandError && error.status === 2 && /Nothing was sent/.test(error.message));
  assert.equal(uploadOf(undefined), null);
  const door = fakeDoor();
  await assert.rejects(run(['op', 'tools:run', PIECE, '--upload', join(folder, 'absent.bin')], door), error => error instanceof CommandError && error.status === 2);
  assert.equal(door.seen.length, 0, 'nothing was sent');
});

test('a raw upload goes to this computer\'s engine when it answers for the door\'s host, and to the door otherwise', async () => {
  const door = { mcp: 'https://site.example/mcp', name: 'Example', local: false };
  const config = { listen: '127.0.0.1:8788', doors: [{ id: 'front', accepts_hosts: ['site.example'] }] };
  assert.deepEqual(uploadDoorHere(door, { config }), { url: 'http://127.0.0.1:8788/mcp', host: 'site.example' });
  assert.equal(uploadDoorHere(door, { config: { ...config, doors: [{ accepts_hosts: ['other.example'] }] } }), null, 'an engine that does not answer for the host');
  assert.equal(uploadDoorHere(door, { config: { ...config, listen: '0.0.0.0:8788' } }), null, 'only a loopback engine');
  assert.equal(uploadDoorHere(door, { config: null }), null, 'no engine here');
  assert.equal(uploadDoorHere({ ...door, local: true }, { config }), null, 'a local door is already this computer');

  const posted = [], fetched = [];
  const reply = init => {
    const message = JSON.parse(Buffer.from(init.headers['x-call'] ?? Buffer.from(init.body).toString('base64url'), 'base64url').toString('utf8'));
    return Response.json({ jsonrpc: '2.0', id: message.id, result: answered });
  };
  const client = engineClient({ door, credential: { kind: 'key', bearer: KEY, where: 't' }, wait: async () => {},
    uploadAt: { url: 'http://127.0.0.1:8788/mcp', host: 'site.example' },
    postAt: async (url, host, init) => { posted.push({ url, host, type: init.headers['content-type'] }); return reply(init); },
    fetchImpl: async (url, init) => { fetched.push({ url, type: init.headers['content-type'] }); return Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: answered }); } });
  await client.op(null, 'tools:run', { tool: 'tool:x' }, { upload: Buffer.from('bytes') });
  await client.op(null, 'tools:run', { tool: 'tool:x' });
  assert.deepEqual(posted, [{ url: 'http://127.0.0.1:8788/mcp', host: 'site.example', type: 'application/octet-stream' }], 'the upload went to this computer\'s engine, naming the door\'s host');
  assert.deepEqual(fetched, [{ url: 'https://site.example/mcp', type: 'application/json' }], 'every other call still goes to the door');
});
