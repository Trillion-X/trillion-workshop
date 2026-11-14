import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  materializeGenericRecordProjection,
  type GenericRecordProjectionActionContract,
} from './generic-record-projection.ts';

const CONTRACT: GenericRecordProjectionActionContract = {
  kind: 'generic-record-projection-action-contract',
  package: 'group-page',
  version: 1,
  record_sources: [
    { role: 'primary-records', address_label: 'records.primary' },
    { role: 'related-records', address_label: 'records.related' },
  ],
  field_descriptors: [
    { id: 'name', label: 'Name', paths: [['name'], ['label']] },
    { id: 'summary', label: 'Summary', paths: [['summary'], ['body'], ['description']] },
    { id: 'state', label: 'State', paths: [['state', 'label'], ['state']] },
    { id: 'future-field', label: 'Future field', paths: [['future', 'text'], ['future']] },
  ],
  relationship_descriptors: [
    {
      id: 'record-to-parent',
      label: 'Parent',
      source_path: ['id'],
      target_path: ['parent_ref'],
      display: { category: 'link', label_path: ['parent_label'], tone_path: ['state'] },
    },
  ],
  projection_descriptors: [{
    id: 'main',
    label: 'Main',
    record_sources: [{ role: 'primary-records' }, { role: 'related-records' }],
    title_field: 'name',
    columns: ['name', 'summary', 'state', 'future-field'],
    relationship_refs: ['record-to-parent'],
    actions: ['record-change', 'invented-later'],
    empty: { title: 'Empty from data' },
  }],
  status_descriptors: [
    { id: 'anything-users-invent', label: 'Anything users invent', tone: 'neutral' },
  ],
  action_descriptors: [
    { id: 'record-change', label: 'Record' },
    { id: 'invented-later', label: 'Invented later' },
  ],
};

describe('materializeGenericRecordProjection', () => {
  it('projects empty, sparse, and dense records from descriptor data', () => {
    const empty = materializeGenericRecordProjection({ contract: CONTRACT, records: [] });
    expect(empty.empty.title).toBe('Empty from data');
    expect(empty.records).toHaveLength(0);

    const sparse = materializeGenericRecordProjection({
      contract: CONTRACT,
      records: [{
        id: 'record:one',
        role: 'primary-records',
        payload: { name: 'One', summary: 'First', state: { label: 'Open from data' } },
      }],
    });
    expect(sparse.records).toHaveLength(1);
    expect(sparse.records[0]?.title).toBe('One');
    expect(sparse.records[0]?.fields.map((field) => field.text)).toContain('Open from data');

    const dense = materializeGenericRecordProjection({
      contract: CONTRACT,
      records: Array.from({ length: 8 }, (_, index) => ({
        id: `record:${index}`,
        role: index % 2 ? 'related-records' : 'primary-records',
        payload: { name: `Record ${index}`, summary: `Summary ${index}`, state: `state-${index}` },
      })),
    });
    expect(dense.records).toHaveLength(8);
    expect(dense.proof.recordCount).toBe(8);
  });

  it('accepts unknown fields and statuses without source changes', () => {
    const surface = materializeGenericRecordProjection({
      contract: CONTRACT,
      records: [{
        id: 'record:future',
        role: 'primary-records',
        payload: {
          name: 'Future',
          future: { text: 'A value invented after the code shipped' },
          state: 'totally-new-state',
        },
      }],
    });

    expect(surface.records[0]?.fields.map((field) => field.text)).toContain(
      'A value invented after the code shipped',
    );
    expect(surface.records[0]?.fields.map((field) => field.text)).toContain('totally-new-state');
  });

  it('keeps nested, repeated, and dangling relationships as data rows', () => {
    const surface = materializeGenericRecordProjection({
      contract: CONTRACT,
      records: [
        {
          id: 'record:child-a',
          role: 'related-records',
          payload: { id: 'record:child-a', name: 'Child A', parent_ref: 'record:missing' },
        },
        {
          id: 'record:child-b',
          role: 'related-records',
          payload: { id: 'record:child-b', name: 'Child B', parent_ref: 'record:missing' },
        },
      ],
    });

    expect(surface.records.flatMap((record) => record.relationships)).toEqual([
      expect.objectContaining({ source: 'record:child-a', target: 'record:missing' }),
      expect.objectContaining({ source: 'record:child-b', target: 'record:missing' }),
    ]);
  });

  it('materializes descriptor-selected actions without action label branches', () => {
    const surface = materializeGenericRecordProjection({
      contract: CONTRACT,
      disabled_actions: { 'invented-later': 'Owner is not ready.' },
    });

    expect(surface.actions).toEqual([
      { id: 'record-change', label: 'Record', enabled: true },
      { id: 'invented-later', label: 'Invented later', enabled: false },
    ]);
  });
});
