// tools/cross-techniques-with-a-goal: rows get one term from a short declared list, read from where the person keeps
// it, by the same words or closeness at the line, else none; a stand-in embedding server gives hand-made vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredTerms, placeRowsInDeclaredTerms, valueAt } from '../do-work/place-rows-in-declared-terms.mjs';

const definitions = { lists: [{ id: 'notes', value: { fields: [{ id: 'colour', choices: ['red'] }] } },
  { id: 'garden', value: { fields: [{ id: 'title' }, { id: 'area', kind: 'choice', choices: ['soil', 'water', 'pests'] }] } }] };

test('a path step { key: value } finds the list element whose key holds the value', () => {
  assert.deepEqual(valueAt(definitions, ['lists', { id: 'garden' }, 'value', 'fields', { id: 'area' }, 'choices']), ['soil', 'water', 'pests']);
  assert.equal(valueAt(definitions, ['lists', { id: 'nowhere' }, 'value']), undefined);
});

test('declared terms come from the request or from the file the person keeps them in, never both', () => {
  const folder = mkdtempSync(join(tmpdir(), 'declared-'));
  const file = join(folder, 'lists.json');
  writeFileSync(file, JSON.stringify(definitions));
  const path = ['lists', { id: 'garden' }, 'value', 'fields', { id: 'area' }, 'choices'];
  assert.deepEqual(declaredTerms({ terms_from: { file, path } }).map(entry => entry.term), ['soil', 'water', 'pests']);
  assert.deepEqual(declaredTerms({ terms: [{ term: 'soil', says: 'the ground' }] }), [{ term: 'soil', says: 'the ground', aliases: [] }]);
  assert.throws(() => declaredTerms({ terms_from: { file, path: ['lists', { id: 'nowhere' }] } }), /No declared terms/);
});

// A stand-in embedding server for the meaning the placing line was measured with: each text's vector is looked up by
// its words, padded to that meaning's dims.
const conventions = JSON.parse(readFileSync(fileURLToPath(new URL('../do-work/technique-conventions.json', import.meta.url)), 'utf8'));
const measured = conventions.placing_line.meaning;
const padded = vector => [...vector, ...Array(measured.dims - vector.length).fill(0)];
const vectors = {
  'title: soil | text: soil': [1, 0, 0], 'title: water | text: water': [0, 1, 0], 'title: pests | text: pests': [0, 0, 1],
  'title: compost | text: compost': [0.95, 0.1, 0], 'title: weather | text: weather': [0.5, 0.5, 0.6],
};
async function withServer(run) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { input } = JSON.parse(body);
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: padded(vectors[text] ?? [0.3, 0.3, 0.3]) })) }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.close();
  }
}

test('each row takes the term of its first word that places: same words, then closeness at the measured line; else none', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'place-'));
  const file = join(folder, 'rows.jsonl');
  writeFileSync(file, [{ id: 'a', tags: ['weather', 'compost'] }, { id: 'b', tags: ['Water'] }, { id: 'c', tags: ['weather'] }].map(row => JSON.stringify(row)).join('\n'));
  const out = join(folder, 'placed.json');
  const result = await withServer(url => placeRowsInDeclaredTerms({
    step: 'place', terms: ['soil', 'water', 'pests'], out_file: out, sources: [{ file, words: ['tags'] }], meaning: { ...measured, url },
  }));
  assert.deepEqual(result.terms, { soil: 1, water: 1, none: 1 });
  const { rows } = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([rows.a.term, rows.a.from, rows.a.how], ['soil', 'compost', 'closest'], 'a first word that does not place gives way to the next');
  assert.deepEqual(rows.b, { term: 'water', from: 'water', how: 'same-words' });
  assert.deepEqual(rows.c, { term: 'none' });
});

test('a meaning other than the one the line was measured with is refused', async () => {
  await assert.rejects(() => placeRowsInDeclaredTerms({ step: 'place', terms: ['soil'], sources: [],
    meaning: { ...measured, url: 'http://127.0.0.1:9/v1', model: 'another-model' } }), /measured placing line is for/);
});
