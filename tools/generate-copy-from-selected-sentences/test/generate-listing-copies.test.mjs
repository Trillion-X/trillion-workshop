import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateCopies, words } from '../do-work/generate-listing-copies.mjs';

const sourceName = 'caller/copy-source.json';
const fixture = () => ({
  name: 'Example', nested: { name: '{name}' },
  sentences: { first: 'Hello {nested.name}.', next: 'Next step.' },
  extension_permissions: { read: 'Read it.', 'optional:write': 'Write it.', 'host:https://example.test/*': 'Load it.', 'content_script:https://example.test/*': 'Show it.' },
  places: [
    { id: 'fields', file: 'fields.json', kind: 'fields', set: [{ path: ['listing', 'title'], say: ['first'] }] },
    { id: 'fields-again', file: 'fields.json', kind: 'fields', set: [{ path: ['listing', 'notes'], say: [['first', 'next']], limit: 30 }] },
    { id: 'block', file: 'readme.md', kind: 'block', block: 'intro', say: ['first', 'next'], join: '\n\n' },
    { id: 'text', file: 'plain.txt', kind: 'text', lines: ['A heading', { say: ['first'] }, ''] },
    { id: 'json', file: 'result.json', kind: 'json', value: { literal: [null, 42, true], title: { say: ['first'] }, borrowed: { from_json: ['manifest.json', 'name'], limit: 20 }, permissions: { permissions_of: 'manifest.json' } } },
  ],
});
const input = {
  'fields.json': JSON.stringify({ listing: { title: '', notes: '' }, keep: true }),
  'readme.md': 'Before\n<!-- how-to-start:intro begin old -->\nold\n<!-- how-to-start:intro end -->\nAfter\n',
  'manifest.json': JSON.stringify({ name: 'Manifest name', permissions: ['read'], optional_permissions: ['write'], host_permissions: ['https://example.test/*'], content_scripts: [{ matches: ['https://example.test/*'] }] }),
};
const read = file => { assert.ok(Object.hasOwn(input, file), `Unexpected read: ${file}`); return input[file]; };
const run = (source = fixture(), outputs = source.places.map(p => p.file), reader = read) => generateCopies(source, { read: reader, outputs, sourceName });

test('renders deterministic fields, blocks, text and JSON without changing supplied data', () => {
  const source = fixture();
  const before = structuredClone(source);
  const result = run(source);
  assert.ok(result instanceof Map);
  assert.deepEqual(result, run(source));
  assert.deepEqual(source, before);
  assert.deepEqual(JSON.parse(result.get('fields.json')), { listing: { title: 'Hello Example.', notes: 'Hello Example. Next step.' }, keep: true });
  assert.equal(result.get('plain.txt'), 'A heading\nHello Example.\n');
  assert.equal(result.get('readme.md'), `Before\n<!-- how-to-start:intro begin: written from ${sourceName}; edit there -->\nHello Example.\n\nNext step.\n<!-- how-to-start:intro end -->\nAfter\n`);
  const second = run(source, source.places.map(p => p.file), file => result.get(file) ?? read(file));
  assert.deepEqual(second, result, 'rendering a legacy marker and then its replacement is idempotent');
  assert.deepEqual(JSON.parse(result.get('result.json')), { literal: [null, 42, true], title: 'Hello Example.', borrowed: 'Manifest name', permissions: source.extension_permissions });
});

test('only explicitly selected outputs render or read, including a three-output caller', () => {
  const selected = ['fields.json', 'plain.txt', 'result.json'];
  assert.deepEqual([...run(fixture(), new Set(selected)).keys()], selected);
  assert.deepEqual([...run(fixture(), []).keys()], []);
  const source = fixture();
  source.places.push({ id: 'unowned', file: 'unowned', kind: 'bad' });
  assert.deepEqual([...run(source, ['plain.txt']).keys()], ['plain.txt']);
  assert.throws(() => generateCopies(source, { read, sourceName }), /outputs/);
  assert.throws(() => run(source, ['typo.json']), /Requested output "typo.json" has no place/);
  source.places = source.places.filter(place => place.file !== 'fields.json');
  assert.throws(() => run(source, selected), /Requested output "fields.json" has no place/);
});

test('tokens expand recursively and refuse cycles or missing text with caller source name', () => {
  assert.equal(words(fixture(), '{nested.name}', [], sourceName), 'Example');
  assert.throws(() => words({ a: '{b}', b: '{a}' }, '{a}'), /refers to itself/);
  assert.throws(() => words({ a: 7 }, '{a}', [], sourceName), /not text in caller\/copy-source.json/);
  assert.throws(() => words({ a: null }, '{a.b}'), /not text/);
});

test('refuses missing sentences, oversized sentences and borrowed text, absent blocks and unknown kinds', () => {
  const source = fixture();
  source.sentences.first = undefined;
  assert.throws(() => run(source), /there is no sentence/);
  source.sentences.first = 'x'.repeat(31);
  assert.throws(() => run(source), /over its limit of 30/);
  const borrowed = fixture();
  borrowed.places.at(-1).value.borrowed.limit = 2;
  assert.throws(() => run(borrowed), /over its limit of 2/);
  assert.throws(() => run(fixture(), ['readme.md'], () => ''), /has no "intro" block/);
  const unknown = fixture();
  unknown.places[0].kind = 'unknown';
  assert.throws(() => run(unknown), /unknown kind/);
});

test('requires reasons for every manifest permission category', () => {
  for (const permission of Object.keys(fixture().extension_permissions)) {
    const source = fixture();
    delete source.extension_permissions[permission];
    assert.throws(() => run(source), error => error.message.includes(permission) && error.message.includes(sourceName) && /gives no reason/.test(error.message));
  }
});

test('selected field, text and JSON bytes agree with the committed original renderer', async () => {
  const baseline = readFileSync(new URL('../source-baselines/generator.mjs.held', import.meta.url), 'utf8');
  const original = await import(`data:text/javascript;base64,${Buffer.from(`const SOURCE = ${JSON.stringify(sourceName)};\n${baseline}`).toString('base64')}`);
  const source = fixture();
  const selected = ['fields.json', 'plain.txt', 'result.json'];
  const legacySource = { ...source, places: source.places.filter(place => selected.includes(place.file)) };
  const reader = file => file === sourceName ? JSON.stringify(legacySource) : read(file);
  const legacy = original.generate(reader);
  const current = run(source, selected);
  assert.equal(current.size, 3);
  for (const file of selected) assert.equal(current.get(file), legacy[file], file);
});
