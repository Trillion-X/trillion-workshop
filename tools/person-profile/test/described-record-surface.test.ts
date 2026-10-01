// Vendored unchanged except for import paths from bitfield-packages/packages/person-profile/tests/described-record-surface.test.ts.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

import {
  type DescribedRecordSurfaceDescriptor,
  projectDescribedRecordSurface,
} from '../read-data/described-record-surface.ts';

const profileDescriptor: DescribedRecordSurfaceDescriptor = {
  kind: 'described-record-surface',
  surfaceId: 'profile.fixture',
  identity: {
    titlePath: ['title'],
    subtitlePath: ['line'],
    badgesPath: ['badges'],
  },
  fields: [
    { id: 'one', label: 'Visible title', valuePath: ['title'], editable: true, saveActionId: 'save-one' },
    { id: 'two', label: 'Long text', valuePath: ['body'], multiline: true },
    { id: 'hidden', label: 'Hidden', valuePath: ['hidden'], visibleWhen: [{ path: ['canSeeHidden'], equals: true }] },
  ],
  relationships: [
    {
      id: 'activity',
      label: 'Activity',
      sourceId: 'related',
      itemPath: ['items'],
      emptyLabel: 'Nothing yet',
      fields: [
        { key: 'primaryText', path: ['title'] },
        { key: 'metaText', path: ['when'] },
      ],
    },
  ],
  actions: [
    { id: 'save-one', label: 'Save', enabled: true, intent: 'primary' },
    { id: 'blocked', label: 'Blocked', enabled: false, disabledReason: 'No access', visibleWhen: [{ path: ['canAct'], equals: true }] },
  ],
};

describe('projectDescribedRecordSurface', () => {
  it('projects profile-shaped records from descriptor data', () => {
    const surface = projectDescribedRecordSurface({
      descriptor: profileDescriptor,
      readerId: 'browser',
      sources: {
        record: {
          title: 'Ava Reed',
          line: 'Community builder',
          body: 'Writes useful updates.',
          canAct: true,
          badges: [{ id: 'trusted', label: 'Trusted' }],
        },
        related: {
          items: [{ id: 'item-1', title: 'Welcomed a new member', when: 'Today' }],
        },
      },
    });

    expect(surface.identity).toMatchObject({ title: 'Ava Reed', subtitle: 'Community builder' });
    expect(surface.fields.map((field) => field.id)).toEqual(['one', 'two']);
    expect(surface.fields[0]).toMatchObject({ editable: true, saveActionId: 'save-one' });
    expect(surface.relationships[0].items[0].values).toEqual({
      primaryText: 'Welcomed a new member',
      metaText: 'Today',
    });
    expect(surface.actions).toEqual([
      { id: 'save-one', label: 'Save', enabled: true, disabledReason: undefined, intent: 'primary' },
      { id: 'blocked', label: 'Blocked', enabled: false, disabledReason: 'No access', intent: 'neutral' },
    ]);
  });

  it('projects non-profile described records without package-specific branches', () => {
    const descriptor: DescribedRecordSurfaceDescriptor = {
      kind: 'described-record-surface',
      surfaceId: 'generic.fixture',
      identity: { titlePath: ['summary'] },
      fields: [
        { id: 'temperature', label: 'Temperature', valuePath: ['temperature'], editable: false },
        { id: 'voltage', label: 'Voltage', valuePath: ['voltage'], editable: true },
      ],
      actions: [{ id: 'calibrate', label: 'Calibrate', target: 'owner-action:anything', method: 'request' }],
    };

    const surface = projectDescribedRecordSurface({
      descriptor,
      sources: { record: { summary: 'Sensor A', temperature: '72F', voltage: '3.3V' } },
      readerId: 'worker',
    });

    expect(surface.surfaceId).toBe('generic.fixture');
    expect(surface.identity.title).toBe('Sensor A');
    expect(surface.fields.map((field) => [field.id, field.value, field.editable])).toEqual([
      ['temperature', '72F', false],
      ['voltage', '3.3V', true],
    ]);
    expect(surface.actions[0]).toMatchObject({ id: 'calibrate', label: 'Calibrate' });
  });
});
