// Source-only comparison prototype: a literal whole record drives a pure consumer without a file copy. The caller reads
// the record and hands it in (record, then the fresh current_record); this code only checks and compares them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecordDocument, projectRecordDocument } from '../read-data/record-document.mjs';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const input = { type: 'synthetic-document', id: 'synthetic-document:registry', content_field: 'source.text' };
const text = '\uFEFF{ "literal": "\\u0061", "name": "Bread 🍞" }\n';
const value = { 'source.text': text, metadata: { keep: true } };
const identity = '900719925474099312345678901234567890';
const record = () => ({ type: input.type, value: structuredClone(value), identity });

test('one whole record the caller handed in becomes an exact frozen in-memory source snapshot', () => {
  const snapshot = readRecordDocument({ ...input, record: record() });
  assert.deepEqual(snapshot, { ...input, source_identity: identity, text,
    content_identity: makeHashCodeHexFromBytes(new TextEncoder().encode(text)), record_value_identity: makeHashCodeHexFromJson(value) });
  assert.equal(Object.isFrozen(snapshot), true);
});

test('a pure consumer uses held exact text and releases only after the fresh record the caller hands in still matches', async () => {
  const result = await projectRecordDocument({ ...input, record: record(), current_record: record() }, { project: (held, snapshot) => {
    assert.equal(held, text);
    assert.equal(snapshot.source_identity, identity);
    return { bytes: [...new TextEncoder().encode(held)], raw: held };
  } });
  assert.deepEqual(result.projection, { bytes: [...new TextEncoder().encode(text)], raw: text });
  assert.equal(result.source.source_identity, identity);
});

test('changed or erased body, metadata, type, identity, deletion and same-body newer revision prevent result release', async () => {
  const changed = [
    { ...record(), value: { ...value, 'source.text': text + 'changed' } },
    { ...record(), value: { ...value, 'source.text': null } },
    { ...record(), value: { ...value, 'source.text': '[erased]' } },
    { ...record(), value: { ...value, metadata: { keep: false } } },
    { ...record(), type: 'other-document' },
    { ...record(), identity: identity + '-new-revision' },
    null,
  ];
  for (const current_record of changed) {
    let released = false;
    await assert.rejects(projectRecordDocument({ ...input, record: record(), current_record }, { project: () => ({ derived: true }) })
      .then(answer => { released = true; return answer; }));
    assert.equal(released, false);
  }
});

test('leaving out the record or its fresh read is refused before the consumer runs, never read as empty', async () => {
  let projects = 0;
  const project = () => { projects++; };
  await assert.rejects(projectRecordDocument({ ...input, record: record() }, { project }), { code: 'bad_input' });
  await assert.rejects(projectRecordDocument({ ...input, current_record: record() }, { project }), { code: 'bad_input' });
  await assert.rejects(projectRecordDocument({ ...input, record: undefined, current_record: record() }, { project }), { code: 'bad_input' });
  assert.throws(() => readRecordDocument(input), { code: 'bad_input' });
  assert.equal(projects, 0);
});

test('a missing identity, nonliteral text and malformed UTF-16 never reach the consumer, and an absent record is named as absent', async () => {
  for (const answer of [{ ...record(), identity: undefined }, { ...record(), identity: '' },
    { ...record(), value: { 'source.text': { derived: true } } }, { ...record(), value: { 'source.text': '\uD800' } }]) {
    let projects = 0;
    await assert.rejects(projectRecordDocument({ ...input, record: answer, current_record: record() }, { project: () => { projects++; } }));
    assert.equal(projects, 0);
  }
  assert.throws(() => readRecordDocument({ ...input, record: null }), { code: 'document_not_found' });
  for (const bad of [{ ...input, content_field: '' }, { ...input, type: '' }, { ...input, id: '' }, { ...input, expected_source_identity: identity }]) {
    assert.throws(() => readRecordDocument({ ...bad, record: record() }), { code: 'bad_input' });
  }
});

test('a failing pure projector propagates and releases nothing without a second comparison', async () => {
  const failure = new Error('Unsupported source');
  await assert.rejects(projectRecordDocument({ ...input, record: record(), current_record: record() }, { project: () => { throw failure; } }), actual => actual === failure);
});
