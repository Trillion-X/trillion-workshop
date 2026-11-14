import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { projectUniversalActionEvents } from '../read-data/project-universal-action-events.ts';
import { fixtureDescriptors, fixtureRecords } from '../read-data/universal-action-event-fixtures.ts';

describe('projectUniversalActionEvents', () => {
  it('projects rows, groups, proof, and disabled actions from descriptors', () => {
    const model = projectUniversalActionEvents({ records: fixtureRecords, descriptors: fixtureDescriptors, selectedId: 'record:2' });
    expect(model.rows.map((row) => row.id)).toEqual(['record:1', 'record:2']);
    expect(model.groups.map((group) => group.id)).toContain('pipeline');
    expect(model.selected?.id).toBe('record:2');
    expect(model.rows[0].proofs[0].text).toBe('Saved');
    expect(model.rows[0].actions.find((action) => action.id === 'action:missing')?.disabledReason).toBe('No owner route is declared.');
  });

  it('keeps unknown domain option values out of code-dependent output', () => {
    const model = projectUniversalActionEvents({
      records: [{ ...fixtureRecords[0], domainOptionRefs: ['descriptor:not-designed'] }],
      descriptors: {
        ...fixtureDescriptors,
        domainOptions: [...(fixtureDescriptors.domainOptions ?? []), { id: 'descriptor:not-designed', label: 'Not designed', role: 'state', group: 'future', order: 99 }],
      },
    });
    expect(model.groups[0].id).toBe('future');
    expect(model.rows[0].options[0].label).toBe('Not designed');
  });
});
