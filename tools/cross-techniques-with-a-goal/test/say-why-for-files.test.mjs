// tools/cross-techniques-with-a-goal: a library whose source files are JSON lines, and a writer behind a server that
// batches only unseeded requests and wraps its JSON in a thinking block and a code fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writer } from '../do-work/meaning.mjs';
import { hashOf, rowsOfFile, sayWhyForFiles, sidecarOf } from '../do-work/say-why-for-files.mjs';

test('a .jsonl source holds one row per line, and its sidecar is named without the .jsonl', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'say-why-files-'));
  const file = join(folder, 'made-up-rows.jsonl');
  writeFileSync(file, `${JSON.stringify({ id: 'r1', statement: 'Plant one bed first.' })}\n\n${JSON.stringify({ id: 'r2', statement: 'Water at dawn.' })}\n`);
  assert.deepEqual(rowsOfFile(file).map(row => row.id), ['r1', 'r2']);
  assert.equal(sidecarOf(file), join(folder, 'made-up-rows.nxn.json'));
  assert.equal(sidecarOf(join(folder, 'rows.json')), join(folder, 'rows.nxn.json'));
  const { rows } = await sayWhyForFiles({ step: 'list', sources: [{ file }], vocabulary_file: join(folder, 'vocabulary.json') });
  assert.deepEqual(rows.map(row => [row.id, row.text]), [['r1', 'statement: Plant one bed first.'], ['r2', 'statement: Water at dawn.']]);
});

test('edited source content cannot expose or settle crossing fields from an older source hash', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'stale-crossing-'));
  const file = join(folder, 'source.jsonl');
  const original = { id: 'r', statement: 'An earlier claim' };
  const proposed = { mechanism: [], operates_on: [], needs: [], produces: [], from_medium: 'fixture' };
  writeFileSync(file, JSON.stringify({ ...original, statement: 'A corrected claim' }));
  writeFileSync(sidecarOf(file), JSON.stringify({ rows: [{ id: 'r', from_hash: hashOf(original), proposed,
    settled_from: hashOf(proposed), mechanism: ['old inference'] }] }));
  const request = { sources: [{ file }], vocabulary_file: join(folder, 'vocabulary.json') };
  assert.deepEqual(await sayWhyForFiles({ ...request, step: 'rows' }), { rows: [] });
  assert.equal((await sayWhyForFiles({ ...request, step: 'list' })).rows.length, 1);
});

test('a writer with seed null sends no seed, sends its body fields, and reads the object out of a thinking block and a fence', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push(JSON.parse(body));
      response.end(JSON.stringify({ choices: [{ message: { content: '<think>{ not this }</think>```json\n{"rows": [1]}\n```' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    const write = writer({ url, model: 'stand-in', seed: null, body: { chat_template_kwargs: { enable_thinking: false } } });
    assert.deepEqual(await write({ system: 's', user: 'u', schema: { type: 'object' }, name: 'n' }), { rows: [1] });
    assert.equal('seed' in seen[0], false);
    assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: false });
    await writer({ url, model: 'stand-in' })({ system: 's', user: 'u', schema: { type: 'object' }, name: 'n' });
    assert.equal(seen[1].seed, 7, 'a writer that names no seed keeps the fixed one');
  } finally {
    server.close();
  }
});

test('a settle that stops keeps every part it finished, and the next settle folds only the rest', async () => {
  const conventions = JSON.parse(readFileSync(fileURLToPath(new URL('../do-work/technique-conventions.json', import.meta.url)), 'utf8'));
  const meaning = conventions.vocabulary_lines.meaning;
  let calls = 0;
  let failFrom = 2;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls += 1;
      if (calls >= failFrom) { response.statusCode = 500; response.end('stopped'); return; }
      const { input } = JSON.parse(body);
      // Each text its own direction, so every term is new and no judge is asked.
      const data = input.map((text, index) => {
        const vector = Array(meaning.dims).fill(0);
        vector[[...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % meaning.dims, 7)] = 1;
        return { index, embedding: vector };
      });
      response.end(JSON.stringify({ data }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const folder = mkdtempSync(join(tmpdir(), 'settle-parts-'));
    const file = join(folder, 'made-up-rows.jsonl');
    const rows = ['plant', 'water', 'weed'].map(word => ({ id: word, statement: `Made-up ${word} rule.` }));
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const proposal = word => ({ mechanism: [{ term: `fixture-${word}-reason`, says: `a made-up reason about ${word}` }], operates_on: [], needs: [], produces: [], from_medium: 'fixture' });
    writeFileSync(sidecarOf(file), JSON.stringify({ rows: rows.map(row => ({ id: row.id, from_hash: hashOf(row), proposed_by: 'stand-in', proposed: proposal(row.id) })) }));
    const request = { step: 'settle', checkpoint_every: 1, sources: [{ file }], vocabulary_file: join(folder, 'vocabulary.json'),
      models: { meaning: { ...meaning, url: `http://127.0.0.1:${server.address().port}/v1` } } };
    await assert.rejects(() => sayWhyForFiles(request), /500/);
    const saved = JSON.parse(readFileSync(sidecarOf(file), 'utf8')).rows;
    assert.deepEqual(saved.filter(row => row.settled_from).map(row => row.id), ['plant'], 'the first part was kept before the stop');
    failFrom = Infinity;
    const resumed = await sayWhyForFiles(request);
    assert.equal(resumed.settled, 2, 'only the rows not yet settled are folded again');
    assert.deepEqual(resumed.files[0].settled, 3);
  } finally {
    server.close();
  }
});
