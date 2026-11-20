// Synthetic source outputs captured before the iterable refactor; no account data.
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rankRows } from '../do-work/process-scripts/nearest-embedding-facts.mjs';
import { pyDumps } from '../do-work/process-scripts/pyjson.mjs';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/nearest-facts-baseline.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../do-work/process-scripts/nearest-embedding-facts.mjs', import.meta.url));

test('nearest CLI retains old source bytes, stdout, qualification, floor and tie order', () => {
  const work = tempFolder(join(tmpdir(), 'nearest-cli-parity-'));
  for (const [at, one] of baseline.cases.entries()) {
    const args = [];
    for (const name of ['embedding', 'input', 'descriptor', 'facts']) {
      const path = join(work, `${at}-${name}.json`);
      writeFileSync(path, JSON.stringify(one[name]));
      args.push(`--${name}-json`, path);
    }
    const output = join(work, `${at}-out.json`);
    const ran = spawnSync(process.execPath, [script, ...args, '--output-json', output], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(readFileSync(output, 'utf8'), one.result_text, one.name);
    assert.equal(ran.stdout, one.stdout, one.name);
  }
});

test('iterable fact ranking equals all facts and leaves query, descriptor and facts unchanged', () => {
  for (const one of baseline.cases) {
    const before = structuredClone(one);
    const rows = Array.isArray(one.facts) ? one.facts : one.facts.items;
    let consumed = 0;
    function* iterable() { for (const row of rows) { consumed += 1; yield row; } }
    const ranked = rankRows({ embedding: one.embedding, input: one.input, descriptor: one.descriptor, rows: iterable() });
    assert.equal(pyDumps(ranked.result, { ensureAscii: true }), one.result_text, one.name);
    assert.equal(consumed, rows.length, 'the full iterable is read exactly once');
    assert.equal(ranked.candidates.length, ranked.ranked_count);
    assert.ok(ranked.candidates.every(item => !Object.hasOwn(item, 'vector') && !Object.hasOwn(item, 'value_json')), 'the global pool contains qualified canonical metadata only');
    assert.deepEqual(one, before, 'caller values stay unchanged');
  }
});

test('direct vector representations reuse the same scorer and metadata qualification', () => {
  for (const one of baseline.cases) {
    const all = Array.isArray(one.facts) ? one.facts : one.facts.items;
    const facts = all.filter(row => { try { return row !== null && JSON.parse(row.value_json) !== null; } catch { return false; } });
    const direct = facts.map(row => ({ subject_id: row.subject_id, ...JSON.parse(row.value_json) }));
    const before = structuredClone(direct);
    const expected = rankRows({ embedding: one.embedding, input: one.input, descriptor: one.descriptor, rows: facts });
    const actual = rankRows({ embedding: one.embedding, input: one.input, descriptor: one.descriptor, rows: direct.values(), representationOf: row => row });
    assert.equal(pyDumps(actual.result, { ensureAscii: true }), pyDumps(expected.result, { ensureAscii: true }), one.name);
    assert.deepEqual(direct, before);
  }
});

test('source float32 arithmetic retains unrounded scores and source ties without changing cosine defaults', () => {
  const metadata = JSON.parse(baseline.cases[0].facts[0].value_json);
  const rows = ['synthetic:z', 'synthetic:a'].map(address => ({ ...metadata, subject_id: address, canonical_address: address, vector: [.6001, 0] }));
  const before = structuredClone(rows);
  const descriptor = { ...baseline.cases[0].descriptor, similarity: 'float32-dot', tie_order: 'source' };
  const args = { embedding: { vector: [1, 0] }, input: { limit: 2 }, descriptor, rows, representationOf: row => row };
  const source = rankRows(args);
  assert.deepEqual(source.result.items.map(item => item.address), ['synthetic:z', 'synthetic:a']);
  assert.equal(source.result.items[0].score.value, Math.fround(.6001));
  const defaults = rankRows({ ...args, descriptor: baseline.cases[0].descriptor });
  assert.deepEqual(defaults.result.items.map(item => item.address), ['synthetic:a', 'synthetic:z']);
  assert.equal(defaults.result.items[0].score.value, 1);
  assert.deepEqual(rows, before);
  assert.throws(() => rankRows({ ...args, descriptor: { ...descriptor, similarity: 'unknown' } }), /similarity must/);
});
