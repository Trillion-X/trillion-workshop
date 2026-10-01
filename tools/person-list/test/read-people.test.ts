// Vendored unchanged except for import paths from bitfield-packages/packages/person-list/read-data/read-people.test.ts.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  decodeAddressedRecords,
  decodeFieldValueRows,
  decodeRecordFieldDescriptors,
  filterAddressedRecords,
  firstText,
  joinFieldValuesToRecords,
  mergeAddressedRecords,
  recordInitial,
  textValue,
  type RecordFieldDescriptor,
} from '../read-data/read-people.ts';

const fields: RecordFieldDescriptor[] = [
  { key: 'display', sourceKeys: ['name', 'label'], displayRole: 'title', searchable: true, order: 1 },
  { key: 'summary', sourceKeys: ['headline', 'description'], displayRole: 'subtitle', searchable: true, order: 2 },
  { key: 'place', sourceKeys: ['city'], displayRole: 'detail', searchable: true, order: 3 },
];

describe('text helpers', () => {
  it('normalizes primitive text values', () => {
    expect(textValue('  hello  ')).toBe('hello');
    expect(textValue(42)).toBe('42');
    expect(textValue(Number.NaN)).toBe('');
    expect(textValue({})).toBe('');
  });

  it('returns the first descriptor source key with content', () => {
    expect(firstText({ a: '', b: 'found' }, ['a', 'b'])).toBe('found');
    expect(firstText({}, ['a'])).toBe('');
  });
});

describe('decodeRecordFieldDescriptors', () => {
  it('decodes descriptor data from rows or wrapper objects', () => {
    expect(decodeRecordFieldDescriptors({ fields: [{ key: 'display', source_keys: ['name'], display_role: 'title' }] })).toEqual([
      { key: 'display', label: undefined, sourceKeys: ['name'], searchable: undefined, displayRole: 'title', order: undefined },
    ]);
  });
});

describe('addressed records', () => {
  it('decodes generic rows from descriptor source keys', () => {
    const records = decodeAddressedRecords([
      { actor_ref: 'actor:a', name: 'Ava', headline: 'Builder', city: 'Austin' },
    ], fields);
    expect(records).toEqual([
      { id: 'actor:a', fields: { display: 'Ava', summary: 'Builder', place: 'Austin' } },
    ]);
  });

  it('uses the same interpreter for a non-person record list', () => {
    const descriptors: RecordFieldDescriptor[] = [
      { key: 'display', sourceKeys: ['title'], displayRole: 'title' },
      { key: 'summary', sourceKeys: ['description'], displayRole: 'subtitle' },
    ];
    const records = decodeAddressedRecords([
      { record_ref: 'idea:one', title: 'Serve robot', description: 'Practice helper' },
    ], descriptors);
    const joined = joinFieldValuesToRecords(records, new Map(), descriptors).records;
    expect(joined[0]).toMatchObject({
      id: 'idea:one',
      title: 'Serve robot',
      subtitle: 'Practice helper',
    });
  });

  it('joins generic field-value rows without field-specific branches', () => {
    const values = decodeFieldValueRows([
      { actor_ref: 'actor:a', request_json: JSON.stringify({ field: 'summary', value: 'Updated' }) },
      { actor_ref: 'actor:a', request_json: JSON.stringify({ field: 'place', value: 'Chicago' }) },
      { actor_ref: 'actor:b', request_json: 'bad-json' },
    ]);
    expect(values.get('actor:a')).toEqual({ summary: 'Updated', place: 'Chicago' });
    expect(values.has('actor:b')).toBe(false);
  });

  it('merges field values and computes display roles from descriptors', () => {
    const records = decodeAddressedRecords([{ actor_ref: 'actor:a', name: 'Ava' }], fields);
    const values = new Map([['actor:a', { summary: 'Updated', place: 'Chicago' }]]);
    const joined = joinFieldValuesToRecords(records, values, fields);
    expect(joined.withFieldValues).toBe(1);
    expect(joined.records[0]).toMatchObject({
      title: 'Ava',
      subtitle: 'Updated',
      detail: 'Chicago',
    });
  });

  it('merges duplicate feeds by first seen id', () => {
    const a = [{ id: 'record:a', fields: { display: 'A' } }];
    const b = [{ id: 'record:a', fields: { display: 'B' } }, { id: 'record:b', fields: {} }];
    expect(mergeAddressedRecords(a, b).map((record) => record.id)).toEqual(['record:a', 'record:b']);
  });

  it('filters across descriptor-marked searchable fields', () => {
    const records = joinFieldValuesToRecords(
      decodeAddressedRecords([
        { actor_ref: 'actor:a', name: 'Ava', headline: 'Builder' },
        { actor_ref: 'actor:b', name: 'Bo', headline: 'Runner' },
      ], fields),
      new Map(),
      fields,
    ).records;
    expect(filterAddressedRecords(records, 'build', fields).map((record) => record.id)).toEqual(['actor:a']);
  });

  it('returns a deterministic initial from any display label', () => {
    expect(recordInitial(' Ava ')).toBe('A');
    expect(recordInitial('')).toBe('?');
  });
});
