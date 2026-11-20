// tools/know-the-projects-on-this-computer/test/publish-current-project.test.mjs
// The pure parts of publish-current-project and its two triggers (verify-every-port L14, C8 to C10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeProjectFromValueJson,
  currentProjectPayload,
  isCurrentProjectChange,
  isRuntimeLoadedEvent,
} from '../do-work/publish-current-project.mjs';

test('the on-change trigger matches only a write to the current-project selection', () => {
  assert.equal(
    isCurrentProjectChange({ subject_id: 'current-project:current', property_id: 'prop:current_project:id' }),
    true,
  );
  assert.equal(isCurrentProjectChange({ subject_id: 'current-project:current', property_id: 'prop:other' }), false);
  assert.equal(isCurrentProjectChange({ subject_id: 'project:x', property_id: 'prop:current_project:id' }), false);
  assert.equal(isCurrentProjectChange(undefined), false);
});

test('the runtime-loaded trigger matches only the runtime_loaded event', () => {
  assert.equal(isRuntimeLoadedEvent({ properties: { event_type: 'runtime_loaded' } }), true);
  assert.equal(isRuntimeLoadedEvent({ properties: { event_type: 'runtime_stopped' } }), false);
  assert.equal(isRuntimeLoadedEvent({}), false);
});

test('the selection is read from its stored JSON text, and an empty or broken value reads as none', () => {
  assert.equal(activeProjectFromValueJson('"project:app-1"'), 'project:app-1');
  assert.equal(activeProjectFromValueJson('""'), null);
  assert.equal(activeProjectFromValueJson('{"a":1}'), null);
  assert.equal(activeProjectFromValueJson('not json'), null);
  assert.equal(activeProjectFromValueJson(undefined), null);
});

test('the sink payload is the one-row list the current-project decoder reads', () => {
  assert.equal(currentProjectPayload('project:app-1'), '[{"activeProject":"project:app-1"}]');
  assert.equal(currentProjectPayload(null), '[]');
  assert.equal(currentProjectPayload(''), '[]');
  assert.deepEqual(JSON.parse(currentProjectPayload('p')), [{ activeProject: 'p' }]);
});
