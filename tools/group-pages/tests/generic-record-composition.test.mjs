import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../read-data/generic-record-projection.ts', import.meta.url), 'utf8');
const fixtures = JSON.parse(await readFile(new URL('./fixtures/generic-record-contracts.json', import.meta.url), 'utf8'));

function valueAt(sourceValue, path) {
  let current = sourceValue;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = value.label ?? value.text ?? value.id;
  return text === undefined ? JSON.stringify(value) : String(text).trim();
}

function firstValue(record, paths) {
  for (const path of paths) {
    const value = valueAt(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function materialize(contract, records, projectionId) {
  const projection = contract.projection_descriptors.find((item) => item.id === projectionId)
    ?? contract.projection_descriptors[0];
  const fieldsById = new Map(contract.field_descriptors.map((field) => [field.id, field]));
  const roles = new Set(projection.record_sources.map((sourceItem) => sourceItem.role));
  return records.filter((record) => roles.has(record.role)).map((record) => ({
    id: record.id,
    title: textOf(firstValue(record.payload, fieldsById.get(projection.title_field)?.paths ?? [])) || record.id,
    fields: projection.columns.map((fieldId) => {
      const field = fieldsById.get(fieldId);
      return { id: fieldId, text: textOf(firstValue(record.payload, field?.paths ?? [])) };
    }),
    relationships: contract.relationship_descriptors.flatMap((descriptor) => {
      if (projection.relationship_refs && !projection.relationship_refs.includes(descriptor.id)) return [];
      const sourceRef = textOf(valueAt(record.payload, descriptor.source_path)) || record.id;
      const targetRef = textOf(valueAt(record.payload, descriptor.target_path));
      return targetRef ? [{ id: descriptor.id, source: sourceRef, target: targetRef }] : [];
    }),
  }));
}

test('generic projection source contains no package-specific split helper', () => {
  assert.equal(source.includes('splitGroupItems'), false);
  assert.equal(source.includes("k === 'reaction'"), false);
  assert.equal(source.includes("k === 'comment'"), false);
  assert.equal(source.includes("'joined' | 'requested'"), false);
});

test('community-like fixture composes fields, relationships, and actions as data', () => {
  const records = materialize(fixtures.communityLike, [
    {
      id: 'page:1',
      role: 'primary-records',
      payload: { id: 'page:1', name: 'Page', summary: 'Readable', state: 'future-state' },
    },
    {
      id: 'item:1',
      role: 'related-records',
      payload: { id: 'item:1', name: 'Child', body: 'Nested', parent_ref: 'page:1', state: { label: 'fresh' } },
    },
  ], 'main');

  assert.equal(records.length, 2);
  assert.equal(records[1].relationships[0].target, 'page:1');
  assert.equal(fixtures.communityLike.action_descriptors[0].id, 'record-change');
});

test('non-community fixture proves the backend primitive is not group-shaped', () => {
  const records = materialize(fixtures.caseWorkLike, [
    {
      id: 'case:1',
      role: 'cases',
      payload: { id: 'case:1', case_title: 'Refund request', risk: { label: 'Escalated' }, next_step: 'Call owner' },
    },
    {
      id: 'note:1',
      role: 'notes',
      payload: { id: 'note:1', case_title: 'Evidence note', case_ref: 'case:1', risk: 'low' },
    },
  ], 'case-list');

  assert.equal(records[0].title, 'Refund request');
  assert.equal(records[0].fields[1].text, 'Escalated');
  assert.equal(records[1].relationships[0].target, 'case:1');
  assert.equal(fixtures.caseWorkLike.action_descriptors[0].id, 'record-case-work');
});

test('empty, malformed, repeated, and dangling rows stay inside the generic shape', () => {
  const records = materialize(fixtures.caseWorkLike, [
    { id: 'dangling:1', role: 'notes', payload: { id: 'dangling:1', case_ref: 'case:missing', risk: null } },
    { id: 'dangling:2', role: 'notes', payload: { id: 'dangling:2', case_ref: 'case:missing', risk: 7 } },
    { id: 'ignored:1', role: 'unknown-role', payload: { case_title: 'Ignored' } },
  ], 'case-list');

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.relationships[0].target), ['case:missing', 'case:missing']);
  assert.equal(records[1].fields.find((field) => field.id === 'risk').text, '7');
});

console.log('[group-page] generic composition proof complete');
