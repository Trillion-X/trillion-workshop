// A clip in the person's Namespace files is read through a link to its bytes: a loopback address that answers byte
// ranges by asking the run's files door for just those bytes, so ffmpeg opens an address and nothing is copied in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { parseRange, rangeServer } from '../read-data/range-server.mjs';
import { openClipLink, withClipAddress } from '../do-work/open-a-clip-link.mjs';

const cutAndCaption = fileURLToPath(new URL('../do-work/cut-and-caption.mjs', import.meta.url));
const available = ['ffprobe', 'ffmpeg'].every(name => spawnSync(name, ['-version']).status === 0);
const filesRight = { files: '/', operations: ['read_file'] };

const patterned = length => Buffer.from(Array.from({ length }, (_, at) => (at * 7 + (at >> 8)) & 255));

test('a byte range header is read as the bytes it names, or refused', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), 'unsatisfiable');
  assert.equal(parseRange(undefined, 100), null);
});

test('the link answers whole, ranged and head requests with the file bytes', async () => {
  const bytes = patterned(1_000_000);
  const asked = [];
  const server = rangeServer({
    byteLength: bytes.length,
    read: async (offset, length) => { asked.push([offset, length]); return bytes.subarray(offset, offset + Math.min(length, 70_000)); },
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/source.mp4`;
  try {
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(asked.length, 0, 'a head request reads nothing');

    const part = await fetch(base, { headers: { range: 'bytes=300000-399999' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 300000-399999/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(300_000, 400_000));
    assert.ok(asked.every(([offset, length]) => offset >= 300_000 && offset + length <= 400_000), 'only the asked bytes were read');

    const tail = await fetch(base, { headers: { range: 'bytes=-1000' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 1000));

    const past = await fetch(base, { headers: { range: `bytes=${bytes.length}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), `bytes */${bytes.length}`);

    assert.deepEqual(Buffer.from(await (await fetch(base)).arrayBuffer()), bytes);
    assert.equal((await fetch(`${base}x`)).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('a door that stops answering bytes ends the response instead of serving a short body', async () => {
  const server = rangeServer({ byteLength: 500_000, read: async () => Buffer.alloc(0) });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    await assert.rejects(async () => (await fetch(`http://127.0.0.1:${server.address().port}/source.mp4`)).arrayBuffer());
  } finally {
    server.close();
  }
});

test('a clip in the Namespace files is read from its link by byte ranges through the run\'s files door', async () => {
  const bytes = patterned(400_000);
  const identity = makeHashCodeHexFromBytes(bytes);
  const door = await startFakeDoor({ rights: [filesRight], files: {} });
  door.stored.set('/Recordings/a/clip.mp4', bytes);
  const link = await openClipLink(identity, { descriptor: door.descriptor });
  try {
    assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/source\.mp4$/);
    const part = await fetch(link.url, { headers: { range: 'bytes=123456-234567' } });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(123_456, 234_568));
    const reads = door.calls.filter(call => call.method === 'read_file' && call.input.length > 0);
    assert.ok(reads.length > 0);
    assert.ok(reads.reduce((sum, call) => sum + call.input.length, 0) < bytes.length, 'the whole file was not read for a range');
    assert.ok(reads.every(call => call.input.name_or_identity === identity));
  } finally {
    await link.close();
    await door.close();
  }
});

test('a clip the run has no right to read is refused with words, not a hang', async () => {
  const bytes = patterned(1000);
  const door = await startFakeDoor({ rights: [], files: {} });
  door.stored.set('/Recordings/a/clip.mp4', bytes);
  try {
    await assert.rejects(openClipLink(makeHashCodeHexFromBytes(bytes), { descriptor: door.descriptor }), /files|rights|refused/i);
  } finally {
    await door.close();
  }
});

test('an address that is not a Namespace identity is handed on unchanged, and an identity becomes a link for the length of the work', async () => {
  assert.equal(await withClipAddress('https://example.test/clip.mp4', async address => address), 'https://example.test/clip.mp4');
  assert.equal(await withClipAddress('/tmp/clip.mp4', async address => address), '/tmp/clip.mp4');
  const bytes = patterned(5000);
  const door = await startFakeDoor({ rights: [filesRight], files: {} });
  door.stored.set('/Recordings/a/clip.mp4', bytes);
  let seen;
  try {
    await withClipAddress(makeHashCodeHexFromBytes(bytes), async address => { seen = address; assert.equal((await fetch(address)).status, 200); }, { descriptor: door.descriptor });
    await assert.rejects(fetch(seen), 'the link ends with the work');
  } finally {
    await door.close();
  }
});

test('cut-and-caption cuts a clip it is given by identity, reading only the ranges ffmpeg asks for', { skip: !available }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'clip-link-'));
  const source = join(work, 'source.mp4');
  // A noisy picture makes the file big enough that a one-second cut must not read all of it.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-c:v', 'libx264', '-b:v', '3M', '-g', '25', '-c:a', 'aac', '-pix_fmt', 'yuv420p', source]);
  const bytes = readFileSync(source);
  const identity = makeHashCodeHexFromBytes(bytes);
  const door = await startFakeDoor({ rights: [filesRight], files: {} });
  door.stored.set('/Recordings/a/clip.mp4', bytes);
  const descriptor = openSync(door.descriptor, 'r');
  try {
    const output = join(work, 'cut.mp4');
    // Asynchronous, so this process keeps answering as the fake door while the cut runs.
    const run = await new Promise(done => {
      const child = spawn(process.execPath, [cutAndCaption, '--video', identity, '--from', '10', '--to', '11', '--output', output], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => done({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const made = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.ok(Math.abs(made.duration_seconds - 1) < 0.25, `the cut is about a second, it was ${made.duration_seconds}`);
    const read = door.calls.filter(call => call.method === 'read_file').reduce((sum, call) => sum + (call.input.length ?? 0), 0);
    assert.ok(read > 0 && read < bytes.length, `read ${read} of ${bytes.length} bytes`);
  } finally {
    closeSync(descriptor);
    await door.close();
    rmSync(work, { recursive: true, force: true });
  }
});
