// The byte hashing the span and writing checks bind to (one BLAKE3 owner, tools/content-identity), checked against an
// independent BLAKE3 where one is installed, and the usage refusals of the two commands. Made-up bytes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuffers, literalPieces, verifySourceSpans } from '../do-work/verify-source-spans.mjs';

const spans = fileURLToPath(new URL('../do-work/verify-source-spans.mjs', import.meta.url));
const writing = fileURLToPath(new URL('../do-work/verify-writing-profile.mjs', import.meta.url));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);

// An independent BLAKE3: Python's blake3 package, when it is installed.
const python = spawnSync('python3', ['-c', 'import blake3'], { encoding: 'utf8' });
const independent = bytes => spawnSync('python3', ['-c', 'import sys, blake3; print(blake3.blake3(sys.stdin.buffer.read()).hexdigest())'],
  { input: bytes, encoding: 'utf8' }).stdout.trim();

test('bulk BLAKE3 keeps exact byte order, BOM bytes, empty inputs and duplicates', { skip: python.status !== 0 && 'python3 blake3 is not installed' }, () => {
  const values = [Buffer.from(''), Buffer.from('﻿first'), Buffer.from('second'), Buffer.from('﻿first')];
  const hashes = hashBuffers(values);
  assert.deepEqual(hashes, values.map(independent));
  assert.equal(hashes[1], hashes[3]);
  assert.notEqual(hashes[1], hashBuffers([Buffer.from('first')])[0]);
});

test('hashing refuses anything that is not a list of byte buffers', () => {
  assert.throws(() => hashBuffers('text'), TypeError);
  assert.throws(() => hashBuffers([Buffer.from('a'), 'b']), TypeError);
  assert.deepEqual(hashBuffers([]), []);
});

test('each command refuses a call without its required paths, with exit 2 and its usage', () => {
  for (const [command, flag] of [[spans, '--data'], [writing, '--document']]) {
    const run = spawnSync(process.execPath, [command], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, new RegExp(`usage: .*${flag}`));
  }
});

test('a relative source path is an invalid binding, never read', () => {
  const data = { schema: 'source-span-bindings-v1', sources: [{ id: 's', path: 'relative.txt', blake3: hashBuffers([Buffer.from('x')])[0] }],
    quotes: [{ id: 'q', source_id: 's', text: 'x', byte_start: 0, byte_end: 1 }] };
  const result = verifySourceSpans(data);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.failures, [{ kind: 'invalid_source_binding' }]);
});

test('literalPieces gives byte positions, not character positions, in a source with multi-byte letters', () => {
  const source = Buffer.from('café noir — zéro sucre, merci');
  const { pieces, unbound } = literalPieces('zéro sucre', source);
  assert.deepEqual(unbound, []);
  assert.equal(source.subarray(pieces[0].byte_start, pieces[0].byte_end).toString(), 'zéro sucre');
  assert.equal(pieces[0].byte_start, Buffer.byteLength('café noir — '));
});

test('the span command binds its report to the manifest bytes it read', () => {
  const folder = mkdtempSync(join(tmpdir(), 'span-manifest-'));
  try {
    const source = join(folder, 'source.txt'), input = join(folder, 'bindings.json'), out = join(folder, 'readback.json');
    writeFileSync(source, 'plum kettle orbit');
    const manifest = JSON.stringify({ schema: 'source-span-bindings-v1', sources: [{ id: 's', path: source, blake3: hashBuffers([readFileSync(source)])[0] }],
      quotes: [{ id: 'q', source_id: 's', text: 'kettle', byte_start: 5, byte_end: 11 }] });
    writeFileSync(input, manifest);
    const run = spawnSync(process.execPath, [spans, '--data', input, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { status: 'passed', sources: 1, quotes: 1, failures: 0 });
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).input_blake3, hashBuffers([Buffer.from(manifest)])[0]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the folder offers one row per job, each running its own command from the checkout root', () => {
  const runs = Object.fromEntries(rows.map(row => [row.id, row.invoke.run]));
  assert.match(runs['tool:pin-files-by-content'], /do-work\/pin-files\.mjs/);
  assert.match(runs['tool:check-quotes-against-their-source-bytes'], /do-work\/verify-source-spans\.mjs --data \{bindings\} --out \{report\}/);
  assert.match(runs['tool:check-prose-against-its-writing-rules'], /do-work\/verify-writing-profile\.mjs --document \{document\} --profile \{profile\}/);
});
