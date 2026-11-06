// A native helper that reads content it did not make runs under a deny-default Seatbelt profile (computer/helper-sandbox.mjs).
// The macOS tests run the REAL helper and probe what the profile holds; they are skipped where there is no sandbox-exec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { confined, helperSettings, profileOf } from '../helper-sandbox.mjs';
import { ocrPixels } from '../observe-visual.mjs';

const settings = helperSettings();
const live = process.platform === 'darwin' && existsSync(settings.program);
// A 64x64 white PNG, made here so the test needs no fixture file.
const png = () => {
  const crc = (() => { const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    return bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

test('a helper without a row is refused, a switched-off row runs as before, and the profile holds only the DATA\'s rules', () => {
  assert.throws(() => confined('no-such-helper', '/bin/echo', []), /No sandbox profile is kept for the helper no-such-helper/);
  const off = structuredClone(settings); off.helpers['image-text'].enabled = false;
  assert.deepEqual(confined('image-text', '/usr/bin/swift', ['x'], { settings: off }), { program: '/usr/bin/swift', args: ['x'] });
  assert.throws(() => confined('image-text', '/usr/bin/swift', [], { exists: () => false }), /was not run unconfined/);
  // The helper's own folder is the one path its profile names; a built app keeps it outside the person's home, so the
  // profile is read as built there (a checkout under the home would put its own folder in). /Applications is that place
  // on a Mac; another computer has no /Applications, so a system folder outside the home stands in for it.
  const profile = profileOf('image-text', { here: existsSync('/Applications') ? '/Applications' : '/usr' });
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.doesNotMatch(profile, /\(allow network/);
  assert.doesNotMatch(profile, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the real image-text helper still reads text out of a picture under its profile', { skip: !live }, async () => {
  const answer = await ocrPixels(png());
  assert.deepEqual([answer.width, answer.height, answer.lines], [64, 64, []]);
});

test('under that profile the person\'s files cannot be read, nothing can be written to their folder, and no connection can be made', { skip: !live }, () => {
  const profile = profileOf('image-text');
  const under = (...command) => spawnSync(settings.program, ['-p', profile, ...command], { encoding: 'utf8' });
  const secret = mkdtempSync(join(homedir(), '.trillion-sandbox-probe-'));
  try {
    writeFileSync(join(secret, 'secret.txt'), 'hunter2');
    assert.equal(execFileSync('/bin/cat', [join(secret, 'secret.txt')], { encoding: 'utf8' }), 'hunter2', 'readable without the profile');
    const read = under('/bin/cat', join(secret, 'secret.txt'));
    assert.notEqual(read.status, 0); assert.doesNotMatch(read.stdout, /hunter2/);
    const write = under('/usr/bin/touch', join(secret, 'planted.txt'));
    assert.notEqual(write.status, 0); assert.equal(existsSync(join(secret, 'planted.txt')), false);
    const net = under('/usr/bin/nc', '-z', '-w', '2', '1.1.1.1', '443');
    assert.notEqual(net.status, 0);
  } finally { rmSync(secret, { recursive: true, force: true }); }
});
