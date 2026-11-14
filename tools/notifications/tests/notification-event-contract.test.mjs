import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));
const payload = (address) => manifest.things.find((thing) => thing.address === address)?.payload;
const action = payload('package::notifications::workflow-action::record-notification-event');
const trigger = payload('package::notifications::trigger-rule::record-declared-progression-notification');
const input = payload('package::notifications::input::notification-events');
assert.equal(action.id, 'action:notifications.record-notification-event');
assert.equal(action.steps[0].config.items[0].path.at(-1), 'notification');
assert.deepEqual(action.input_schema.required.includes('audience_refs'), true);
assert.deepEqual(action.input_schema.properties.privacy_class, { const: 'private' });
assert.equal(trigger.dispatch.output_template.definition_id, action.id);
assert.equal(trigger.match_condition.conditions[1].transform[0].op, 'op:core.is_not_null');
assert.equal(input.value_address_label, 'package::notifications::notification-events-feed');
console.log('notification event owner contract passed');
