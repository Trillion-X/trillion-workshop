// tools/who-does-each-step/test/who-does.test.mjs
//
// Every doer, reason, step and word here is made up; the tool knows none of them. The cases are the old module's, on a
// bakery shelf-test plan instead of the one it was written for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { covers, whoCanDo, whoDoesEachStep } from '../read-data/who-does.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const doers = [
  { id: 'my-ais', label: 'My AIs', does: ['write', 'make a qr code', 'make a waitlist'], hand_off: true, cost: { usd: 0 } },
  { id: 'store-finder', label: 'Nearest places', does: ['choose a store', 'find the nearest'], tool_id: 'tool:store-finder', cost: { usd: 0 } },
  { id: 'directions', label: 'Directions', does: ['directions'], tool_id: 'tool:directions', cost: { usd: 0 } },
  { id: 'print-a-file', label: 'Print on my printer', does: ['print labels', 'print'], cost: { usd: 0 } },
  { id: 'print-shop', label: 'A print shop', does: ['print at shelf scale', 'print'], purpose: 'print-and-deliver', spends: true, cost: { usd: 25, per: 'order' } },
  { id: 'field-helper', label: 'A person on the spot', does: ['observe shoppers', 'bring a clipboard'], reaches_others: true, cost: { usd: 15, per: 'hour' } },
  { id: 'sign-in-with-a-saved-login', label: 'Sign in with a saved login', does: ['sign in'], how: 'Open the site and sign in with the saved login.', cost: { usd: 0 } },
];
const reasons = [
  { id: 'their-own-taste', words: 'it is their own taste the result exists to capture' },
  { id: 'their-own-consent', words: 'it is their consent', given_once: true },
  { id: 'a-sign-in-only-they-can', words: 'it is a code only on their own device', first_try: 'sign-in-with-a-saved-login' },
  { id: 'their-own-body', words: 'it has to be their own body there' },
];
const plan = [
  { id: 'print', words: 'Print the packaging at shelf scale', needs: ['print at shelf scale'] },
  { id: 'store', words: 'Pick the nearest store', needs: ['choose a store'] },
  { id: 'drive', words: 'Drive there', needs: ['directions'] },
  { id: 'gear', words: 'Bring a clipboard', needs: ['bring a clipboard'] },
  { id: 'qr', words: 'Make a QR code to a waitlist page', needs: ['make a qr code', 'make a waitlist'] },
  { id: 'watch', words: 'Watch shoppers at the shelf', needs: ['observe shoppers'] },
  { id: 'taste', words: 'Say which box you like best', only_a_person_because: 'their-own-taste', needs: ['print labels'] },
  { id: 'fly', words: 'Teleport the pallet', needs: ['teleport a pallet'] },
];
const ask = (extra = {}) => whoDoesEachStep({ doers, only_a_person: reasons, ...extra });

test('no step of the plan lands on the person as a to-do', () => {
  const answer = ask({ steps: plan });
  const by = Object.fromEntries(answer.steps.map(step => [step.id, step]));
  assert.equal(by.store.who, 'trillion');
  assert.equal(by.store.doers[0].tool_id, 'tool:store-finder');
  assert.equal(by.drive.doers[0].tool_id, 'tool:directions');
  assert.equal(by.qr.who, 'trillion');
  assert.equal(by.qr.doers[0].hand_off, true);
  // Spending money or reaching a stranger is one tap with its price, never a silent spend.
  assert.equal(by.print.who, 'one-tap');
  assert.equal(by.print.doers[0].purpose, 'print-and-deliver');
  assert.match(by.print.said, /\$25 order/);
  assert.equal(by.watch.who, 'one-tap');
  assert.equal(by.gear.who, 'one-tap');
  // The person's own part carries its reason and every helping doer.
  assert.equal(by.taste.who, 'you');
  assert.equal(by.taste.reason, 'their-own-taste');
  assert.equal(by.taste.doers[0].id, 'print-a-file');
  // Nothing can do it yet: a doer to build, never the person's job.
  assert.equal(by.fly.who, 'nobody-yet');
  assert.deepEqual(by.fly.uncovered, ['teleport a pallet']);
  assert.deepEqual(answer.counts, { trillion: 3, 'one-tap': 3, you: 1, 'nobody-yet': 1 });
  assert.match(answer.said, /^3 done for you, 3 one tap, 1 only you, 1 to be built\.$/);
});

test('a doer said yes to once runs without a tap, and past failures move a doer down', () => {
  assert.equal(ask({ steps: [plan[0]], approved: ['print-shop'] }).steps[0].who, 'trillion');
  const pair = { doers: [{ id: 'a', label: 'A', does: ['print'] }, { id: 'b', label: 'B', does: ['print'] }], words: { trillion: '{doers}', joiner: ',', summary: '' } };
  assert.equal(whoDoesEachStep({ ...pair, steps: ['print'] }).steps[0].doers[0].id, 'a');
  assert.equal(whoDoesEachStep({ ...pair, steps: ['print'], past: [{ doer: 'a', result: 'failed' }] }).steps[0].doers[0].id, 'b');
  assert.equal(whoDoesEachStep({ ...pair, steps: ['print'], past: [{ doer: 'a', result: 'failed' }], ranking: { failed: 0 } }).steps[0].doers[0].id, 'a');
  assert.equal(whoDoesEachStep({ ...pair, steps: ['print'] }).steps[0].said, 'A', 'a request brings its own words over the defaults');
});

test('the most specific phrase wins: shelf-scale printing goes to a shop, labels to the printer', () => {
  assert.equal(covers('print', 'print at shelf scale'), 1);
  assert.equal(covers('print at shelf scale', 'print at shelf scale'), 3);
  assert.equal(covers('print', 'teleport'), 0);
  assert.equal(ask({ steps: [{ words: 'labels', needs: ['print labels'] }] }).steps[0].doers[0].id, 'print-a-file');
});

test('consent the person already gave in their own words is never asked again', () => {
  const step = { words: 'Let my AIs read my saved logins', needs: [], only_a_person_because: 'their-own-consent' };
  assert.equal(ask({ steps: [step] }).steps[0].who, 'you');
  const given = ask({ steps: [{ ...step, given_in: 'message:abc' }] }).steps[0];
  assert.deepEqual([given.who, given.given_in], ['trillion', 'message:abc']);
  assert.match(given.said, /You already said yes \(message:abc\), so this is done for you without asking again\./);
  assert.equal(ask({ steps: [{ words: 'Record your voice', only_a_person_because: 'their-own-body', given_in: 'message:x' }] }).steps[0].who, 'you', 'a reason not met once is not lifted by an earlier message');
});

test('a sign-in goes to the AIs with the saved logins first and is the person\'s only after they were stopped', () => {
  const step = { words: 'Sign in to the shop page', only_a_person_because: 'a-sign-in-only-they-can' };
  const first = ask({ steps: [step] }).steps[0];
  assert.deepEqual([first.who, first.first_try, first.doers.map(doer => doer.id)], ['trillion', 'sign-in-with-a-saved-login', ['sign-in-with-a-saved-login']]);
  assert.ok(first.doers[0].how);
  const failed = [{ doer: 'sign-in-with-a-saved-login', result: 'failed' }];
  assert.deepEqual([ask({ steps: [{ ...step, past: failed }] }).steps[0].who, ask({ steps: [step], past: failed }).steps[0].who], ['you', 'you']);
  assert.equal(ask({ steps: [{ words: 'Record your voice', only_a_person_because: 'their-own-body' }] }).steps[0].who, 'you');
});

test('the list of doers and reasons is told back, and a request that is not plainly shaped is refused', () => {
  const told = whoCanDo({ doers, only_a_person: reasons });
  assert.deepEqual(told.doers.map(doer => doer.id), doers.map(doer => doer.id));
  assert.deepEqual(told.doers.find(doer => doer.id === 'print-shop'), { id: 'print-shop', label: 'A print shop', does: ['print at shelf scale', 'print'], cost: { usd: 25, per: 'order' }, spends: true, reaches_others: false });
  assert.equal(told.only_a_person.length, 4);
  assert.throws(() => whoDoesEachStep({ steps: ['x'] }), /doers is a list/);
  assert.throws(() => whoDoesEachStep({ steps: ['x'], doers: [{ id: 'a' }] }), /Each doer is/);
  assert.throws(() => whoDoesEachStep({ steps: ['x'], doers, only_a_person: [{ id: 'r' }] }), /only_a_person is a list/);
  assert.throws(() => whoDoesEachStep([]), /Send an object/);
});

test('the rows pack what the tools read and run their own samples', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:who-does-each-step', 'tool:what-can-trillion-do']);
  for (const row of rows) assert.deepEqual(row.invoke.files.package_files.paths, ['do-work', 'read-data']);
  assert.equal(whoDoesEachStep(rows[0].verify[0].input).steps[0].who, 'trillion');
  assert.equal(whoCanDo(rows[1].verify[0].input).doers[0].id, 'sample-doer');
});
