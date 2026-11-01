// The four notification rows run as the container runs them, against the fake records door with exactly each row's rights.
// The setting and the people are made up: a bakery that lets its owner choose how orders are announced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const choiceRow = rowOf(rows, 'tool:my-notification-choice');
const chooseRow = rowOf(rows, 'tool:choose-my-notification-choice');
const recordRow = rowOf(rows, 'tool:record-a-notification');
const eventsRow = rowOf(rows, 'tool:my-notification-events');

const setting = (options, extra = {}) => ({
  id: 'notification-setting:order-alerts', type: 'notification-setting',
  value: { title: 'Order alerts', description: 'How the bakery tells me about orders.', options, ...extra },
});
const options = [
  { id: 'every-order', label: 'Every order', description: 'Tell me about each order' },
  { value: 'daily-summary', label: 'Daily summary' },
  { id: 'quiet' },
];
const chosen = value => ({ id: 'notification-choice:order-alerts', type: 'notification-choice', value: { value, at: '2026-01-01T00:00:00Z' } });
const event = (id, extra = {}) => ({
  notification_id: id, kind: 'order.ready', audience_refs: ['person:baker'], conversation_ref: 'conversation:counter',
  privacy_class: 'private', title: `Order ${id} is ready`, body: 'Two loaves are ready for pickup.', occurred_at: '2026-01-02T08:00:00Z',
  source_refs: ['order:1'], proof_refs: ['proof:1'], ...extra,
});
const kept = (answer, id) => answer.kept.find(record => record.id === id);

test('the options come from the person\'s setting, an option may be given as id or value, and the default is the current choice', async () => {
  const answer = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting(options, { default: 'quiet' })] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.options.map(option => [option.id, option.label, option.current]), [['every-order', 'Every order', false], ['daily-summary', 'Daily summary', false], ['quiet', 'quiet', true]]);
  assert.equal(answer.result.heading, 'Order alerts');
  assert.equal(answer.result.status, 'ready');
  assert.equal(answer.result.said, 'The current choice is quiet.');
});

test('a saved choice wins over the default, and no choice at all is said plainly', async () => {
  const saved = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting(options, { default: 'quiet' }), chosen('every-order')] });
  assert.equal(saved.result.current, 'every-order');
  const none = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting(options)] });
  assert.equal(none.result.current, null);
  assert.equal(none.result.said, 'No choice is saved yet.');
});

test('a saved choice the options no longer hold is reported as invalid and left as it is', async () => {
  const answer = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting(options), chosen('retired-option')] });
  assert.equal(answer.result.status, 'invalid');
  assert.equal(answer.result.current, 'retired-option');
  assert.equal(kept(answer, 'notification-choice:order-alerts').value.value, 'retired-option');
});

test('an option may be given by key, and a setting with no options is empty, and a setting that is not there is said in words with what to do', async () => {
  const keyed = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting([{ key: 'by-key', label: 'By key' }, { id: '', value: '', key: 'second' }])] });
  assert.deepEqual(keyed.result.options.map(option => option.id), ['by-key', 'second']);
  const empty = await runRow(choiceRow, { setting: 'order-alerts' }, { records: [setting([])] });
  assert.equal(empty.result.status, 'empty');
  const missing = await runRow(choiceRow, { setting: 'order-alerts' });
  assert.equal(missing.status, 0, missing.error);
  assert.equal(missing.result.status, 'missing');
  assert.deepEqual(missing.result.options, []);
  assert.match(missing.result.said, /no notification setting order-alerts.*notification-setting record/);
  const unnamed = await runRow(choiceRow, {});
  assert.match(unnamed.error, /Say which setting/);
});

test('choosing keeps the option, says what it replaced, and choosing it again changes nothing', async () => {
  const first = await runRow(chooseRow, { setting: 'order-alerts', choice: 'daily-summary' }, { records: [setting(options), chosen('every-order')] });
  assert.equal(first.status, 0, first.error);
  assert.deepEqual([first.result.choice, first.result.previous, first.result.changed], ['daily-summary', 'every-order', true]);
  assert.equal(kept(first, 'notification-choice:order-alerts').value.value, 'daily-summary');
  assert.match(kept(first, 'notification-choice:order-alerts').value.at, /^\d{4}-\d\d-\d\dT/);
  const again = await runRow(chooseRow, { setting: 'order-alerts', choice: 'every-order' }, { records: [setting(options), chosen('every-order')] });
  assert.equal(again.result.changed, false);
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0);
});

test('a choice that is not an option is refused, and a setting that is missing or has no options says so and nothing is written', async () => {
  const wrong = await runRow(chooseRow, { setting: 'order-alerts', choice: 'shout' }, { records: [setting(options)] });
  assert.equal(wrong.status, 1);
  assert.match(wrong.error, /shout is not an option of order-alerts. The options are every-order, daily-summary, quiet/);
  assert.equal(wrong.kept.some(record => record.type === 'notification-choice'), false);
  const none = await runRow(chooseRow, { setting: 'order-alerts', choice: 'quiet' }, { records: [setting([])] });
  assert.equal(none.status, 0, none.error);
  assert.equal(none.result.changed, false);
  assert.match(none.result.said, /describes no choices/);
  const absent = await runRow(chooseRow, { setting: 'order-alerts', choice: 'quiet' });
  assert.equal(absent.status, 0, absent.error);
  assert.equal(absent.result.changed, false);
  assert.match(absent.result.said, /no notification setting order-alerts.*Nothing was chosen/);
  assert.equal(absent.calls.filter(call => call.method === 'records:write').length, 0);
  const blank = await runRow(chooseRow, { setting: 'order-alerts' }, { records: [setting(options)] });
  assert.match(blank.error, /Say what to choose/);
});

test('an operation without the declared write right is refused by the records door', async () => {
  const denied = { ...chooseRow, invoke: { ...chooseRow.invoke, records: { ...chooseRow.invoke.records, rights: [] } } };
  const answer = await runRow(denied, { setting: 'order-alerts', choice: 'every-order' }, { records: [setting(options)] });
  assert.equal(answer.status, 1);
  assert.match(answer.error, /may not reach those records/i);
  assert.equal(answer.kept.some(record => record.type === 'notification-choice'), false);
});

test('an event is recorded as given, delivers nothing, and the same event again changes nothing', async () => {
  const first = await runRow(recordRow, event('n1'));
  assert.equal(first.status, 0, first.error);
  assert.deepEqual(first.result, { notification_id: 'n1', recorded: true, said: 'n1 is recorded for 1 audience; nothing was delivered.' });
  assert.deepEqual(kept(first, 'notification-event:n1').value, event('n1'));
  assert.equal(kept(first, 'notification-event:n1').type, 'notification-event');
  const again = await runRow(recordRow, event('n1'), { records: first.kept });
  assert.deepEqual(again.result, { notification_id: 'n1', recorded: false, said: 'n1 was already recorded.' });
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0);
  const reordered = Object.fromEntries(Object.entries(event('n1')).reverse());
  assert.equal((await runRow(recordRow, reordered, { records: first.kept })).result.recorded, false);
});

test('notice actions keep their native payload intact and reject duplicate or unusable actions', async () => {
  const actions = [
    { id: 'accept', label: 'Accept', post: { path: '/work/api/spaces/invitations/answer', body: { request_id: '{request_id}', accept: true } } },
    { id: 'open', label: 'Open pursuit', press: true, open: { surface_id: 'app.space', input: { id: '{space_id}' } } },
  ];
  const accepted = await runRow(recordRow, event('with-actions', { actions }));
  assert.equal(accepted.status, 0, accepted.error);
  assert.deepEqual(kept(accepted, 'notification-event:with-actions').value.actions, actions);
  const duplicate = await runRow(recordRow, event('duplicate-actions', { actions: [actions[0], actions[0]] }));
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.error, /duplicate id/);
  const noEffect = await runRow(recordRow, event('empty-action', { actions: [{ id: 'noop', label: 'No action' }] }));
  assert.equal(noEffect.status, 1);
  assert.match(noEffect.error, /must offer/);
});

test('a different event under a recorded id is refused and the first one stays', async () => {
  const first = await runRow(recordRow, event('n1'));
  const clash = await runRow(recordRow, event('n1', { body: 'Something else.' }), { records: first.kept });
  assert.equal(clash.status, 1);
  assert.match(clash.error, /different notification is already recorded as n1/);
  assert.equal(kept(clash, 'notification-event:n1').value.body, 'Two loaves are ready for pickup.');
});

test('an event with a field missing, an empty audience, a stray field or no words is refused with each problem named', async () => {
  const { audience_refs, title, ...rest } = event('n2');
  const bad = await runRow(recordRow, { ...rest, source_refs: [], proof_refs: ['proof:1', ''], extra: true, idempotencyKey: 5 });
  assert.equal(bad.status, 1);
  for (const named of ['audience_refs is required', 'title is required', 'source_refs is required', 'proof_refs is required', 'extra is not a field', 'idempotencyKey must be words']) {
    assert.ok(bad.error.includes(named), `${named} in: ${bad.error}`);
  }
  assert.equal(bad.kept.length, 0);
});

test('events are limited to the kinds and privacy classes the person\'s rules list, and any words pass when there are none', async () => {
  const rules = { id: 'notification-event-rules:events', type: 'notification-event-rules', value: { kinds: ['order.ready', 'order.late'], privacy_classes: ['private'] } };
  const fine = await runRow(recordRow, event('r1'), { records: [rules] });
  assert.equal(fine.result.recorded, true);
  const bad = await runRow(recordRow, event('r2', { kind: 'other.kind', privacy_class: 'public' }), { records: [rules] });
  assert.equal(bad.status, 1);
  assert.ok(bad.error.includes('kind other.kind is not one of the kinds'), bad.error);
  assert.ok(bad.error.includes('privacy_class public is not one of the privacy classes'), bad.error);
  assert.equal(bad.kept.some(record => record.type === 'notification-event'), false);
  const free = await runRow(recordRow, event('r3', { kind: 'anything', privacy_class: 'whatever' }));
  assert.equal(free.result.recorded, true);
  const partial = await runRow(recordRow, event('r4', { privacy_class: 'public' }), { records: [{ ...rules, value: { kinds: ['order.ready'] } }] });
  assert.equal(partial.result.recorded, true);
});

test('the optional operation, transition and key fields are kept when given', async () => {
  const answer = await runRow(recordRow, event('n3', { operationId: 'op-1', transitionId: 't-1', idempotencyKey: 'k-1' }));
  assert.equal(answer.result.recorded, true);
  assert.equal(kept(answer, 'notification-event:n3').value.idempotencyKey, 'k-1');
});

test('events are read for the audience they name, newest occurrence first, with a limit', async () => {
  const records = [
    { id: 'notification-event:a', type: 'notification-event', value: event('a', { occurred_at: '2026-01-01T00:00:00Z' }) },
    { id: 'notification-event:b', type: 'notification-event', value: event('b', { occurred_at: '2026-01-03T00:00:00Z', audience_refs: ['person:baker', 'person:cashier'] }) },
    { id: 'notification-event:c', type: 'notification-event', value: event('c', { occurred_at: '2026-01-02T00:00:00Z', audience_refs: ['person:cashier'] }) },
  ];
  const baker = await runRow(eventsRow, { audience: 'person:baker' }, { records });
  assert.deepEqual(baker.result.events.map(item => item.notification_id), ['b', 'a']);
  assert.equal(baker.result.said, '2 events for person:baker, newest first.');
  const one = await runRow(eventsRow, { audience: 'person:baker', limit: 1 }, { records });
  assert.deepEqual(one.result.events.map(item => item.notification_id), ['b']);
  assert.match(one.result.said, /1 older not shown/);
  assert.deepEqual((await runRow(eventsRow, { audience: 'person:nobody' }, { records })).result.events, []);
  assert.match((await runRow(eventsRow, {}, { records })).error, /Say whose events/);
});

test('each row asks the door for no more than its job needs', () => {
  assert.deepEqual(choiceRow.invoke.records.rights, [{ kind: 'notification-setting', operations: ['records:read'] }, { kind: 'notification-choice', operations: ['records:read'] }]);
  assert.deepEqual(chooseRow.invoke.records.rights, [{ kind: 'notification-setting', operations: ['records:read'] }, { kind: 'notification-choice', operations: ['records:read', 'records:write'] }]);
  assert.deepEqual(recordRow.invoke.records.rights, [{ kind: 'notification-event', operations: ['records:read', 'records:write'] }, { kind: 'notification-event-rules', operations: ['records:read'] }]);
  assert.deepEqual(eventsRow.invoke.records.rights, [{ kind: 'notification-event', operations: ['records:list'] }]);
});
