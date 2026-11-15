// Source-only comparison prototype: a literal whole record drives a pure consumer without a file copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecordDocument, projectRecordDocument } from '../read-data/record-document.mjs';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const input = { type: 'synthetic-document', id: 'synthetic-document:registry', content_field: 'source.text' };
const text = '\uFEFF{ "literal": "\\u0061", "name": "Bread 🍞" }\n';
const value = { 'source.text': text, metadata: { keep: true } };
const identity = '900719925474099312345678901234567890';
const record = () => ({ type: input.type, value: structuredClone(value), identity });

function owner(answers = [record(), record()]) {
  const reads = [];
  const door = {
    async readRecord(type, id) {
      reads.push({ type, id });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    read() { throw new Error('A value-only read cannot establish native source identity.'); },
    list() { throw new Error('Multipart reads cannot establish one whole-record source.'); },
    run() { throw new Error('No file copy or source tool may run.'); },
    write() { throw new Error('This projection owns no write.'); },
  };
  return { door, reads };
}

test('one native whole-record envelope becomes an exact frozen in-memory source snapshot', async () => {
  const { door, reads } = owner();
  const snapshot = await readRecordDocument(input, { door });
  assert.deepEqual(snapshot, { ...input, source_identity: identity, text,
    content_identity: makeHashCodeHexFromBytes(new TextEncoder().encode(text)), record_value_identity: makeHashCodeHexFromJson(value) });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(reads, [{ type: input.type, id: input.id }]);
});

test('a pure consumer uses held exact text and releases only after a fresh native source read', async () => {
  const { door, reads } = owner();
  const result = await projectRecordDocument(input, { door, project: (held, snapshot) => {
    assert.equal(held, text);
    assert.equal(snapshot.source_identity, identity);
    assert.equal(reads.length, 1);
    return { bytes: [...new TextEncoder().encode(held)], raw: held };
  } });
  assert.deepEqual(result.projection, { bytes: [...new TextEncoder().encode(text)], raw: text });
  assert.equal(result.source.source_identity, identity);
  assert.equal(reads.length, 2);
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
  for (const after of changed) {
    const { door } = owner([record(), after]);
    let released = false;
    await assert.rejects(projectRecordDocument(input, { door, project: () => ({ derived: true }) }).then(answer => { released = true; return answer; }));
    assert.equal(released, false);
  }
});

test('native refusals and unknown reads propagate without release or hidden retries', async () => {
  for (const point of ['initial', 'release']) {
    for (const error of [Object.assign(new Error('Read refused'), { code: 'current_workspace_rights_refused', outcome: 'not_started' }),
      Object.assign(new Error('Read unknown'), { code: 'original_workspace_source_unavailable', outcome: 'unknown' })]) {
      const { door, reads } = owner(point === 'initial' ? [error] : [record(), error]);
      let projects = 0;
      await assert.rejects(projectRecordDocument(input, { door, project: () => { projects++; return 'derived'; } }), actual => actual === error);
      assert.equal(projects, point === 'initial' ? 0 : 1);
      assert.equal(reads.length, point === 'initial' ? 1 : 2);
    }
  }
});

test('restart after a changed source starts with a fresh admitted envelope, never a saved copy or old token', async () => {
  const next = { ...record(), identity: 'opaque-new-stamp', value: { ...value, 'source.text': 'new source\n' } };
  const { door, reads } = owner([record(), next, next, next]);
  await assert.rejects(projectRecordDocument(input, { door, project: held => held }), { code: 'document_source_changed' });
  const resumed = await projectRecordDocument(input, { door, project: held => held.toUpperCase() });
  assert.equal(resumed.source.source_identity, next.identity);
  assert.equal(resumed.projection, 'NEW SOURCE\n');
  assert.equal(reads.length, 4);
});

test('missing identity, nonliteral text, malformed UTF-16 and invalid input never reach the consumer', async () => {
  for (const answer of [null, { ...record(), identity: undefined }, { ...record(), identity: '' },
    { ...record(), value: { 'source.text': { derived: true } } }, { ...record(), value: { 'source.text': '\uD800' } }]) {
    const { door } = owner([answer]);
    let projects = 0;
    await assert.rejects(projectRecordDocument(input, { door, project: () => { projects++; } }));
    assert.equal(projects, 0);
  }
  const { door, reads } = owner();
  for (const bad of [{ ...input, content_field: '' }, { ...input, type: '' }, { ...input, id: '' }, { ...input, expected_source_identity: identity }]) {
    await assert.rejects(readRecordDocument(bad, { door }), { code: 'bad_input' });
  }
  assert.equal(reads.length, 0);
});

test('a failing pure projector propagates and releases nothing without an unnecessary second read', async () => {
  const { door, reads } = owner();
  const failure = new Error('Unsupported source');
  await assert.rejects(projectRecordDocument(input, { door, project: () => { throw failure; } }), actual => actual === failure);
  assert.equal(reads.length, 1);
});
