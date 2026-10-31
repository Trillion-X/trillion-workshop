// The four request rows run as the container runs them, against the fake records door with exactly each row's rights.
// Carries the cases of the package's action, decision and receipt tests with made-up data: a bakery whose counter staff
// and oven manager are the owners, and a note left by the baker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const takeRow = rowOf(rows, 'tool:take-a-request');
const handRow = rowOf(rows, 'tool:hand-a-request-to-its-owner');
const receiptRow = rowOf(rows, 'tool:record-the-owners-receipt');
const listRow = rowOf(rows, 'tool:my-requests');

const origins = { id: 'intake-origins:accepted', type: 'intake-origins', value: { origins: ['counter-note'] } };
const owner = (ref, active = true) => ({ id: `intake-owner:${ref}`, type: 'intake-owner', value: { owner_ref: ref, active } });
const note = (extra = {}) => ({ request_id: 'note-1', source_ref: 'notebook', message_ref: 'page-4', atom_ref: 'atom:line-2', text: 'Bake sourdough on Fridays', origin_ref: 'counter-note', at: '2026-01-02T08:00:00Z', ...extra });
const handing = { disposition: 'ask', reason: 'The baker asked for it plainly', hand_to_owner: true, owner_ref: 'oven-manager', acceptance_criteria: 'Sourdough is on the Friday bake list' };
const handOff = { action_ref: 'add-to-bake-list', input: { list: 'friday' } };
const kept = (answer, id) => answer.kept.find(record => record.id === id);
const writes = answer => answer.calls.filter(call => call.method === 'records:write').length;

test('a plain acknowledgement is kept with no hand-off and no owner request', async () => {
  const answer = await runRow(takeRow, { request: note({ request_id: 'thanks', text: 'Thanks!' }), decision: { disposition: 'context', reason: 'Acknowledgement, no work asked' } }, { records: [origins] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual([answer.result.status, answer.result.owner_request, answer.result.problems], ['recorded', null, []]);
  assert.equal(kept(answer, 'intake-request:thanks').value.owner_ref, null);
  assert.equal(answer.kept.some(record => record.type === 'owner-action-request'), false);
});

test('a request handed to an owner on file is kept and the owner is asked once with what the request carries', async () => {
  const answer = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records: [origins, owner('oven-manager')] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual([answer.result.status, answer.result.owner_request], ['handed', 'owner-action-request:intake-request:note-1:0']);
  const asked = kept(answer, 'owner-action-request:intake-request:note-1:0').value;
  assert.deepEqual([asked.owner, asked.actionRef, asked.status, asked.requested_at], ['oven-manager', 'add-to-bake-list', 'requested', '2026-01-02T08:00:00Z']);
  assert.deepEqual(asked.input.field_values, { asked: 'Bake sourdough on Fridays', asked_at: '2026-01-02T08:00:00Z', said_in: 'atom:line-2', owner: 'oven-manager', success: 'Sourdough is on the Friday bake list' });
  assert.deepEqual([asked.input.list, asked.input.proof_links, asked.input.record_ref], ['friday', ['atom:line-2'], 'note-1']);
  const record = kept(answer, 'intake-request:note-1').value;
  assert.deepEqual([record.status, record.owner_ref, record.owner_request, record.receipt_refs], ['handed', 'oven-manager', 'owner-action-request:intake-request:note-1:0', []]);
  assert.equal(writes(answer), 1);
});

test('an owner who is not on file, or is not active, gets no request and nothing is kept, so taking it again later is a first take', async () => {
  for (const records of [[origins], [origins, owner('oven-manager', false)]]) {
    const answer = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records });
    assert.equal(answer.result.status, 'deferred');
    assert.deepEqual(answer.result.problems.map(problem => problem.code), ['owner_not_resolved']);
    assert.deepEqual(answer.kept.filter(record => record.type !== 'intake-origins' && record.type !== 'intake-owner'), []);
    assert.equal(writes(answer), 0);
    const listed = await runRow(listRow, {}, { records: answer.kept });
    assert.deepEqual(listed.result.requests, []);
    const retried = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records: [origins, owner('oven-manager')] });
    assert.equal(retried.result.status, 'handed');
  }
});

test('a text longer than the bound is kept cut when nothing is handed over, and held back with nothing kept when an owner is to act on it', async () => {
  const long = 'x'.repeat(70000);
  const records = [origins, owner('oven-manager')];
  const plain = await runRow(takeRow, { request: note({ text: long }), decision: { disposition: 'context', reason: 'A long note' } }, { records });
  assert.equal(plain.result.status, 'recorded');
  assert.equal(kept(plain, 'intake-request:note-1').value.text.length, 65536);
  const held = await runRow(takeRow, { request: note({ text: long }), decision: handing, hand_off: handOff }, { records });
  assert.deepEqual([held.result.status, held.result.problems.map(problem => problem.code), writes(held)], ['deferred', ['text_too_long'], 0]);
  const short = await runRow(takeRow, { request: note({ text: 'Bake sourdough on Fridays' }), decision: handing, hand_off: handOff, max_text_chars: 10 }, { records });
  assert.equal(short.result.status, 'deferred');
  const cut = await runRow(takeRow, { request: note({ text: 'Bake sourdough on Fridays' }), decision: { disposition: 'context', reason: 'ok' }, max_text_chars: 10 }, { records });
  assert.equal(kept(cut, 'intake-request:note-1').value.text, 'Bake sourd');
  const both = await runRow(takeRow, { request: note({ text: long }), decision: { ...handing, owner_ref: 'nobody' }, hand_off: handOff }, { records });
  assert.deepEqual(both.result.problems.map(problem => problem.code), ['owner_not_resolved', 'text_too_long']);
  assert.match((await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff, max_text_chars: 0 }, { records })).error, /max_text_chars/);
});

test('a decision that points at an existing task is refused and nothing is kept', async () => {
  const answer = await runRow(takeRow, { request: note(), decision: { ...handing, existing_task_ref: 'task-7' }, hand_off: handOff }, { records: [origins, owner('oven-manager')] });
  assert.deepEqual([answer.result.status, answer.result.problems.map(problem => problem.code), writes(answer)], ['refused', ['current_task_executor_not_verified'], 0]);
  assert.match(answer.result.said, /task-7/);
  const plain = await runRow(takeRow, { request: note(), decision: { disposition: 'context', reason: 'ok', existing_task_ref: 'task-7' } }, { records: [origins] });
  assert.equal(plain.result.status, 'refused');
});

test('taking the same request again changes nothing, and the same id from another source is refused', async () => {
  const first = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records: [origins, owner('oven-manager')] });
  const again = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records: first.kept });
  assert.deepEqual([again.result.status, again.result.owner_request], ['already-taken', 'owner-action-request:intake-request:note-1:0']);
  assert.equal(writes(again), 0);
  const clash = await runRow(takeRow, { request: note({ source_ref: 'voicemail' }), decision: handing, hand_off: handOff }, { records: first.kept });
  assert.deepEqual([clash.result.status, clash.result.problems.map(problem => problem.code)], ['refused', ['source_identity_conflict']]);
  assert.equal(writes(clash), 0);
  for (const change of [{ message_ref: 'page-5' }, { atom_ref: 'atom:line-3' }, { content_revision: 'v2' }]) {
    const changed = await runRow(takeRow, { request: note(change), decision: handing, hand_off: handOff }, { records: first.kept });
    assert.deepEqual([changed.result.status, changed.result.problems.map(problem => problem.code)], ['refused', ['source_identity_conflict']], JSON.stringify(change));
    assert.equal(writes(changed), 0);
  }
  const versioned = await runRow(takeRow, { request: note({ content_revision: 'v1' }), decision: { disposition: 'context', reason: 'ok' } }, { records: [origins] });
  assert.equal((await runRow(takeRow, { request: note({ content_revision: 'v1' }), decision: { disposition: 'context', reason: 'ok' } }, { records: versioned.kept })).result.status, 'already-taken');
  assert.equal((await runRow(takeRow, { request: note(), decision: { disposition: 'context', reason: 'ok' } }, { records: versioned.kept })).result.status, 'refused');
});

test('an origin the person does not accept, an incomplete request and an incomplete decision are refused with nothing written', async () => {
  const records = [origins, owner('oven-manager')];
  const copy = await runRow(takeRow, { request: note({ origin_ref: 'assistant-copy' }), decision: handing, hand_off: handOff }, { records });
  assert.deepEqual(copy.result.problems.map(problem => problem.code), ['origin_not_accepted']);
  const bare = await runRow(takeRow, { request: note({ text: '  ' }), decision: handing, hand_off: handOff }, { records });
  assert.deepEqual(bare.result.problems.map(problem => problem.code), ['request_incomplete']);
  assert.match(bare.result.said, /lacks text/);
  const undecided = await runRow(takeRow, { request: note(), decision: { disposition: 'ask', reason: ' ' } }, { records });
  assert.deepEqual(undecided.result.problems.map(problem => problem.code), ['decision_incomplete']);
  for (const answer of [copy, bare, undecided]) { assert.equal(answer.result.status, 'refused'); assert.equal(writes(answer), 0); }
});

test('with no accepted origins on file nothing is taken and the answer says what to save', async () => {
  const answer = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual([answer.result.status, answer.result.request_id, answer.result.problems.map(problem => problem.code), writes(answer)], ['refused', 'note-1', ['no_accepted_origins'], 0]);
  assert.match(answer.result.said, /No accepted origins are on file.*intake-origins:accepted/);
});

test('handing to an owner without saying what to run is refused, whether or not the owner is on file', async () => {
  for (const records of [[origins, owner('oven-manager')], [origins]]) {
    const answer = await runRow(takeRow, { request: note(), decision: handing }, { records });
    assert.equal(answer.status, 1);
    assert.match(answer.error, /Name what the owner is asked to run/);
    assert.equal(writes(answer), 0);
  }
});

test('the hand-off may carry copy rows, and the owner is told what success looks like, with a plain default', async () => {
  const withCopy = { action_refs: ['add-to-bake-list'], copy: [{ key: 'said', from: 'request.operation_id' }, { key: 'who', from: 'fields.owner' }, { key: 'fixed', value: 3 }] };
  const answer = await runRow(takeRow, { request: note(), decision: { ...handing, acceptance_criteria: undefined }, hand_off: withCopy }, { records: [origins, owner('oven-manager')] });
  assert.equal(answer.status, 0, answer.error);
  const asked = kept(answer, 'owner-action-request:intake-request:note-1:0').value.input;
  assert.deepEqual([asked.said, asked.who, asked.fixed], ['intake-request:note-1', 'oven-manager', 3]);
  assert.equal(asked.field_values.success, 'The requested outcome is verified.');
});

const action = { id: 'ask-the-owner', owner: 'oven-manager', action_refs: ['first-definition', 'second-definition'], input: { fixed: true }, copy: [{ key: 'copied_answer', from: 'answers.note' }, { key: 'copied_field', from: 'fields.item' }, { key: 'constant', value: 7 }] };
const context = { operation_id: 'op-1', record_ref: 'record-1', shape_ref: 'shape-a', field_values: { item: 'Rye loaf' }, answers: { note: 'Two dozen' }, requested_at: '2026-01-03T00:00:00Z' };

test('an action with two action refs asks the owner twice with the fixed input, the answers and the copied values', async () => {
  const answer = await runRow(handRow, { action, context });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.handed, ['owner-action-request:op-1:0', 'owner-action-request:op-1:1']);
  assert.deepEqual(answer.kept.map(record => record.value.actionRef), ['first-definition', 'second-definition']);
  const input = answer.kept[0].value.input;
  assert.deepEqual([input.fixed, input.note, input.copied_answer, input.copied_field, input.constant], [true, 'Two dozen', 'Two dozen', 'Rye loaf', 7]);
  assert.deepEqual([input.action_id, input.record_ref, input.shape_ref, input.linked_receipt_refs, input.receipt_ref], ['ask-the-owner', 'record-1', 'shape-a', [], null]);
});

test('asking again with the same operation is the same request and leaves what the owner has done to it', async () => {
  const first = await runRow(handRow, { action, context });
  const touched = first.kept.map(record => (record.id.endsWith(':0') ? { ...record, value: { ...record.value, status: 'done' } } : record));
  const again = await runRow(handRow, { action, context }, { records: touched });
  assert.deepEqual([again.result.handed, again.result.already.length], [[], 2]);
  assert.match(again.result.said, /oven-manager was already asked/);
  assert.match(first.result.said, /^Asked oven-manager/);
  assert.equal(writes(again), 0);
  assert.equal(touched.find(record => record.id.endsWith(':0')).value.status, 'done');
});

test('an action with no owner, no action ref or no operation id is refused with what to give', async () => {
  assert.match((await runRow(handRow, { action: { ...action, owner: '' }, context })).error, /needs an owner/);
  assert.match((await runRow(handRow, { action: { owner: 'oven-manager' }, context })).error, /needs an action_ref/);
  assert.match((await runRow(handRow, { action, context: { ...context, operation_id: '' } })).error, /operation_id/);
});

test('a receipt is kept, linked to its request, and linked again changes nothing', async () => {
  const taken = await runRow(takeRow, { request: note(), decision: handing, hand_off: handOff }, { records: [origins, owner('oven-manager')] });
  const receipt = { ref: 'receipt-1', owner_ref: 'oven-manager', title: 'Added to the Friday list', summary: 'Done', process_ref: 'run-9', raw: { loaves: 12 } };
  const linked = await runRow(receiptRow, { request_id: 'note-1', receipt }, { records: taken.kept });
  assert.equal(linked.status, 0, linked.error);
  assert.deepEqual([linked.result.linked, linked.result.said], [true, 'receipt-1 is linked to note-1.']);
  assert.deepEqual(kept(linked, 'intake-request:note-1').value.receipt_refs, ['receipt-1']);
  assert.deepEqual([kept(linked, 'intake-receipt:receipt-1').value.process_ref, kept(linked, 'intake-receipt:receipt-1').value.raw], ['run-9', { loaves: 12 }]);
  const again = await runRow(receiptRow, { request_id: 'note-1', receipt }, { records: linked.kept });
  assert.equal(again.result.linked, false);
  assert.equal(writes(again), 0);
  const second = await runRow(receiptRow, { request_id: 'note-1', receipt: { ...receipt, ref: 'receipt-2', owner_ref: 'counter-staff', title: 'Told the counter' } }, { records: linked.kept });
  assert.deepEqual(kept(second, 'intake-request:note-1').value.receipt_refs, ['receipt-1', 'receipt-2']);
});

test('a receipt for a request that is not there is said in words with nothing linked, and one that already answers another request is refused', async () => {
  const receipt = { ref: 'receipt-1', owner_ref: 'oven-manager', title: 'Done' };
  const absent = await runRow(receiptRow, { request_id: 'missing', receipt });
  assert.equal(absent.status, 0, absent.error);
  assert.deepEqual([absent.result.request_id, absent.result.linked, writes(absent)], ['missing', false, 0]);
  assert.match(absent.result.said, /There is no request missing/);
  const records = [
    { id: 'intake-request:a', type: 'intake-request', value: { request_id: 'a', receipt_refs: [] } },
    { id: 'intake-receipt:receipt-1', type: 'intake-receipt', value: { ref: 'receipt-1', request_id: 'b' } },
  ];
  const clash = await runRow(receiptRow, { request_id: 'a', receipt }, { records });
  assert.match(clash.error, /already answers a different request/);
  assert.match((await runRow(receiptRow, { request_id: 'a', receipt: { ref: 'x' } }, { records })).error, /Pass request_id and receipt/);
});

test('the list shows each request with its receipts, who still owes an answer, and filters by owner and by waiting', async () => {
  const records = [origins, owner('oven-manager'), owner('counter-staff')];
  let state = records;
  for (const [id, at, who] of [['n1', '2026-01-01T00:00:00Z', 'oven-manager'], ['n2', '2026-01-02T00:00:00Z', 'counter-staff'], ['n3', '2026-01-03T00:00:00Z', 'oven-manager']]) {
    state = (await runRow(takeRow, { request: note({ request_id: id, at }), decision: { ...handing, owner_ref: who }, hand_off: handOff }, { records: state })).kept;
  }
  state = (await runRow(takeRow, { request: note({ request_id: 'n0', at: '2025-12-31T00:00:00Z' }), decision: { disposition: 'context', reason: 'just context' } }, { records: state })).kept;
  state = (await runRow(receiptRow, { request_id: 'n1', receipt: { ref: 'r1', owner_ref: 'oven-manager', title: 'Done' } }, { records: state })).kept;
  const all = await runRow(listRow, {}, { records: state });
  assert.equal(all.status, 0, all.error);
  assert.deepEqual(all.result.requests.map(request => [request.request_id, request.status, request.waiting_on_owner, request.receipts.length]),
    [['n3', 'handed', true, 0], ['n2', 'handed', true, 0], ['n1', 'handed', false, 1], ['n0', 'recorded', false, 0]]);
  assert.equal(all.result.said, '4 requests, newest first; 2 waiting on an owner.');
  assert.deepEqual((await runRow(listRow, { waiting: true }, { records: state })).result.requests.map(request => request.request_id), ['n3', 'n2']);
  assert.deepEqual((await runRow(listRow, { owner: 'oven-manager' }, { records: state })).result.requests.map(request => request.request_id), ['n3', 'n1']);
  const one = await runRow(listRow, { limit: 1 }, { records: state });
  assert.match(one.result.said, /3 older not shown/);
  assert.equal((await runRow(listRow, {})).result.said, '0 requests, newest first; 0 waiting on an owner.');
});

test('each row asks the door for no more than its job needs', () => {
  const kinds = row => row.invoke.records.rights.map(right => `${right.kind}:${right.operations.join('+')}`);
  assert.deepEqual(kinds(takeRow), ['intake-origins:records:read', 'intake-owner:records:read', 'intake-request:records:read+records:write', 'owner-action-request:records:read+records:write']);
  assert.deepEqual(kinds(handRow), ['owner-action-request:records:read+records:write']);
  assert.deepEqual(kinds(receiptRow), ['intake-request:records:read+records:write', 'intake-receipt:records:read+records:write']);
  assert.deepEqual(kinds(listRow), ['intake-request:records:list', 'intake-receipt:records:list']);
});

test('every row\'s sample run passes against an empty door, which is how it is verified', async () => {
  for (const row of [takeRow, handRow, receiptRow, listRow]) {
    const [sample] = row.verify;
    assert.equal(sample.kind, 'sample-run', row.id);
    const answer = await runRow(row, sample.input);
    assert.equal(answer.status, 0, `${row.id}: ${answer.error}`);
    const found = sample.output_selector.replace('$.', '').split('.').reduce((from, key) => from[key], answer.result);
    assert.ok(JSON.stringify(found).includes(sample.contains), row.id);
  }
});
