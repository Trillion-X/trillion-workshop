import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hashBuffers, literalPieces, verifySourceSpans} from '../do-work/verify-source-spans.mjs';

const hash = bytes => hashBuffers([Buffer.from(bytes)])[0];

test('literal byte spans preserve Unicode, case and explicit positions', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-spans-'));
  try {
    const path = join(folder, 'source.txt'), text = 'é THESE → source. THESE';
    writeFileSync(path, text);
    const digest = hash(Buffer.from(text));
    const data = {schema: 'synthetic-d245bc86d584', sources: [{id: '__proto__', path, blake3: digest}],
      quotes: [{id: 'constructor', source_id: '__proto__', text: 'THESE', byte_start: 3, byte_end: 8}]};
    assert.equal(verifySourceSpans(data).passed, true);
    const changed = mutate => { const copy = structuredClone(data); mutate(copy); return verifySourceSpans(copy); };
    assert.equal(changed(d => d.quotes[0].text = 'these').failures[0].kind, 'quote_literal_mismatch');
    const wrongOffset = changed(d => {d.quotes[0].byte_start = 4; d.quotes[0].byte_end = 9;});
    assert.equal(wrongOffset.failures[0].literal_present_elsewhere, true);
    assert.equal(wrongOffset.passed, false);
    assert.equal(changed(d => {d.quotes[0].byte_start = 1; d.quotes[0].byte_end = 2;}).failures[0].kind, 'quote_splits_utf8');
    assert.equal(changed(d => d.quotes[0].byte_end = 999).failures[0].kind, 'quote_range_outside_source');
    assert.equal(changed(d => d.quotes[0].byte_start = 0.5).status, 'invalid');
    assert.equal(changed(d => d.quotes.push(d.quotes[0])).status, 'invalid');
    assert.equal(changed(d => d.sources[0].blake3 = '0'.repeat(64)).failures[0].kind, 'source_hash_mismatch');
    writeFileSync(path, text + ' changed');
    assert.equal(verifySourceSpans(data).passed, false);
    const bomText = '\uFEFFTHESE';
    writeFileSync(path, bomText);
    data.sources[0].blake3 = hash(bomText);
    data.quotes[0] = {id: 'bom', source_id: '__proto__', text: 'THESE', byte_start: 0, byte_end: Buffer.byteLength(bomText)};
    assert.equal(verifySourceSpans(data).failures[0].kind, 'quote_literal_mismatch');
    data.quotes[0].text = bomText;
    assert.equal(verifySourceSpans(data).passed, true);
    writeFileSync(path, Buffer.from([0xff]));
    data.sources[0].blake3 = hash(Buffer.from([0xff]));
    assert.equal(verifySourceSpans(data).failures[0].kind, 'source_invalid_utf8');
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('readable source snapshots are hashed together while unreadable rows keep their indexed failure', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-spans-partial-'));
  try {
    const path = join(folder, 'source.txt'), text = '\uFEFFreadable bytes';
    writeFileSync(path, text);
    const digest = hash(Buffer.from(text));
    const result = verifySourceSpans({schema: 'synthetic-d245bc86d584', sources: [
      {id: 'missing', path: join(folder, 'missing.txt'), blake3: digest},
      {id: 'readable', path, blake3: digest},
    ], quotes: [
      {id: 'missing-quote', source_id: 'missing', text: 'missing', byte_start: 0, byte_end: 7},
      {id: 'readable-quote', source_id: 'readable', text, byte_start: 0, byte_end: Buffer.byteLength(text)},
    ]});
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.sources.map(row => row.source_index), [1]);
    assert.deepEqual(result.quotes.map(row => row.passed), [false, true]);
    assert.deepEqual(result.failures.map(row => row.kind), ['source_unreadable', 'quote_source_unavailable']);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('real CLI preserves failed evidence, emits no quote bodies and never overwrites reports', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-spans-cli-'));
  try {
    const source = join(folder, 'source.txt'), input = join(folder, 'input.json'), output = join(folder, 'output.json');
    const body = 'PRIVATE BODY must not appear in diagnostics.';
    writeFileSync(source, body);
    const digest = hash(body);
    // IDs can also carry accidental private text; report only ordinal positions.
    const data = {schema: 'synthetic-d245bc86d584', sources: [{id: body, path: source, blake3: digest}],
      quotes: [{id: body, source_id: body, text: body.toLowerCase(), byte_start: 0, byte_end: Buffer.byteLength(body)}]};
    writeFileSync(input, JSON.stringify(data));
    const cli = new URL('../do-work/verify-source-spans.mjs', import.meta.url).pathname;
    const invoke = target => spawnSync(process.execPath, [cli, '--data', input, '--out', target], {encoding: 'utf8'});
    const failed = invoke(output); assert.equal(failed.status, 1, failed.stderr);
    const failedBytes = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(failedBytes).failures[0].kind, 'quote_literal_mismatch');
    assert.equal(JSON.parse(failedBytes).failures[0].quote_index, 0);
    assert.equal(JSON.parse(failedBytes).input_blake3,
      hash(readFileSync(input)));
    assert.equal((failed.stdout + failed.stderr + failedBytes).includes('PRIVATE BODY'), false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    data.quotes[0].text = body; writeFileSync(input, JSON.stringify(data));
    const fresh = join(folder, 'accepted.json'); assert.equal(invoke(fresh).status, 0);
    assert.equal(JSON.parse(readFileSync(fresh)).passed, true);
    assert.equal(readFileSync(fresh, 'utf8').includes('PRIVATE BODY'), false);
    assert.equal(invoke(output).status, 2);
    assert.equal(readFileSync(output, 'utf8'), failedBytes);
    // JSON decoding must not silently replace invalid UTF-8 before its hash is bound.
    const malformed = Buffer.from(JSON.stringify(data));
    malformed[malformed.indexOf('PRIVATE BODY')] = 0xff;
    writeFileSync(input, malformed);
    const invalid = invoke(join(folder, 'invalid.json'));
    assert.equal(invalid.status, 2);
    assert.equal((invalid.stdout + invalid.stderr).includes('PRIVATE BODY'), false);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('literalPieces finds the longest literal runs of a text in a source and lists the words it cannot find', () => {
  const source = Buffer.from('we leverage the old notes, like, every single day');
  const { pieces, unbound } = literalPieces('we leverage the old notes... every single day [daily].', source);
  assert.deepEqual(pieces.map(piece => piece.text), ['we leverage the old notes', 'every single day']);
  assert.deepEqual(unbound, ['daily']);
  assert.equal(source.subarray(pieces[1].byte_start, pieces[1].byte_end).toString(), 'every single day');
  assert.deepEqual(literalPieces('We leverage it', source).unbound, ['We', 'it']);   // a changed capital is not the source's literal word
  assert.deepEqual(literalPieces('every single day we leverage', source).unbound, ['we', 'leverage']);   // the source's words reordered
});
