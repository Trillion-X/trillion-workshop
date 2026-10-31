// tools/cross-techniques-with-a-goal: a library whose source files are JSON lines, and a writer behind a server that
// batches only unseeded requests and wraps its JSON in a thinking block and a code fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writer } from '../do-work/meaning.mjs';
import { rowsOfFile, sayWhyForFiles, sidecarOf } from '../do-work/say-why-for-files.mjs';

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
