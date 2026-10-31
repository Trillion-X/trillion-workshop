// Carried from bitfield-packages packages/person-profile/tests/person-profile-boundary.test.ts and backend-proof.test.mjs.
// The package guard read the old engine's things-to-store-and-run.json and walked every source file; here it reads the
// generic parts (the interpreter, the reader-keyed materialization, the action builder), where a profile-specific
// family or field word would be a leak. The member profile's own file names its record fields on purpose and is not
// one of them. The two projection tests of backend-proof.test.mjs (profile and non-profile fixtures, descriptor-driven
// action and materialization) run the same fixtures on the carried code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectDescribedRecordSurface } from '../read-data/described-record-surface.ts';
import { buildDescribedRecordActionRequest } from '../do-work/described-record-action.ts';
import { materializeDescribedRecordSurface } from '../read-data/described-record-materialization.ts';

const generic = ['read-data/described-record-surface.ts', 'read-data/described-record-materialization.ts', 'do-work/described-record-action.ts'];

test('the generic parts name no profile backend family, reader vocabulary or direct execution constant', () => {
  const forbidden = [
    /\b(profile-http|profile-sync|profile-workflow|profile-crm|profile-calendar|profile-mail|profile-provider|person-profile-mobile|person-profile-ios)\b/,
    /\b(FIELD_SLOTS|full_name|display_name|recent posts|reaction|comment)\b/,
    /\b(slot::workflow|execute_definition|action:person-profile|save-person-profile|actor:local)\b/,
  ];
  const offenders = generic.flatMap(file => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    return forbidden.filter(pattern => pattern.test(text)).map(() => file);
  });
  assert.deepEqual(offenders, []);
});

test('described-record projection works for profile and non-profile fixtures', () => {
  const profileSurface = projectDescribedRecordSurface({
    readerId: 'browser',
    descriptor: {
      kind: 'described-record-surface',
      surfaceId: 'profile.fixture',
      identity: { titlePath: ['title'], subtitlePath: ['line'], badgesPath: ['badges'] },
      fields: [
        { id: 'one', label: 'Visible title', valuePath: ['title'], editable: true, saveActionId: 'save-one' },
        { id: 'two', label: 'Long text', valuePath: ['body'], multiline: true },
        { id: 'hidden', label: 'Hidden', valuePath: ['hidden'], visibleWhen: [{ path: ['canSeeHidden'], equals: true }] },
      ],
      relationships: [{
        id: 'activity',
        label: 'Activity',
        sourceId: 'related',
        itemPath: ['items'],
        fields: [{ key: 'primaryText', path: ['title'] }, { key: 'metaText', path: ['when'] }],
      }],
      actions: [{ id: 'save-one', label: 'Save', enabled: true, intent: 'primary' }],
    },
    sources: {
      record: { title: 'Ava Reed', line: 'Community builder', body: 'Writes useful updates.', badges: [{ id: 'trusted' }] },
      related: { items: [{ id: 'item-1', title: 'Welcomed a new member', when: 'Today' }] },
    },
  });
  assert.equal(profileSurface.identity.title, 'Ava Reed');
  assert.deepEqual(profileSurface.fields.map(field => field.id), ['one', 'two']);
  assert.deepEqual(profileSurface.relationships[0].items[0].values, { primaryText: 'Welcomed a new member', metaText: 'Today' });

  const genericSurface = projectDescribedRecordSurface({
    readerId: 'worker',
    descriptor: { kind: 'described-record-surface', surfaceId: 'generic.fixture', identity: { titlePath: ['summary'] }, fields: [{ id: 'temperature', label: 'Temperature', valuePath: ['temperature'] }] },
    sources: { record: { summary: 'Sensor A', temperature: '72F' } },
  });
  assert.equal(genericSurface.identity.title, 'Sensor A');
  assert.equal(genericSurface.fields[0].value, '72F');
});

test('action builder and reader materialization are descriptor-driven', () => {
  const action = buildDescribedRecordActionRequest({
    actionId: 'save-field',
    operationId: 'op-1',
    values: { fieldId: 'display-title', value: 'Ava' },
    sources: { actor: { id: 'actor-1' } },
    descriptors: [{ id: 'save-field', target: 'owner-action:described-record-change', method: 'request', input: { surfaceId: 'surface-1' }, bindings: [{ key: 'actorId', source: 'actor', path: ['id'] }] }],
  });
  assert.deepEqual(action.errors, []);
  assert.equal(action.requests[0].target, 'owner-action:described-record-change');
  assert.equal(action.requests[0].payload.input.actorId, 'actor-1');

  const descriptor = { kind: 'described-record-surface', surfaceId: 'shared.fixture', identity: { titlePath: ['label'] }, fields: [{ id: 'field-a', label: 'Field A', valuePath: ['value'], editable: true }] };
  const browser = materializeDescribedRecordSurface({ descriptor, sources: { record: { label: 'Shared', value: 'same' } }, readerId: 'browser' });
  const native = materializeDescribedRecordSurface({ descriptor, sources: { record: { label: 'Shared', value: 'same' } }, readerId: 'ios' });
  assert.deepEqual(browser.value.fields, native.value.fields);
});
