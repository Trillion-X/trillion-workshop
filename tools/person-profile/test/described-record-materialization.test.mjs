// Carried from bitfield-packages packages/person-profile/tests/described-record-materialization.test.ts, on node:test
// and assert instead of vitest. Its last assertion converted the surface to a screen section list
// (show/person-profile-screen-model.ts); that screen model stays with the screens, so the same source is checked here
// by what the surface itself holds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { materializeDescribedRecordSurface } from '../read-data/described-record-materialization.ts';

const descriptor = {
  kind: 'described-record-surface',
  surfaceId: 'shared.fixture',
  identity: { titlePath: ['label'] },
  fields: [{ id: 'field-a', label: 'Field A', valuePath: ['value'], editable: true }],
};

describe('reader keyed materialization', () => {
  it('keeps browser and native readers on the same source value', () => {
    const sources = { record: { label: 'Shared source', value: 'same value' } };
    const browser = materializeDescribedRecordSurface({ descriptor, sources, readerId: 'browser', transport: 'dom-json' });
    const native = materializeDescribedRecordSurface({ descriptor, sources, readerId: 'ios', transport: 'native-json' });

    assert.deepEqual(browser.key, { surfaceId: 'shared.fixture', readerId: 'browser', transport: 'dom-json' });
    assert.deepEqual(native.key, { surfaceId: 'shared.fixture', readerId: 'ios', transport: 'native-json' });
    assert.deepEqual(browser.value.fields, native.value.fields);
    assert.equal(browser.value.identity.title, 'Shared source');
  });
});
