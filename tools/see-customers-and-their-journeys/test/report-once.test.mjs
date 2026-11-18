import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createHandToAccount } from '../read-data/hand-to-an-account.mjs';

const invoke = fixtures.tray.records[0].payload.invoke;
const tools = [{ invoke }];
const handoffs = createHandToAccount(fixtures.reports, { reportKindOf: value => value });
const report = (note = 'Original report') => ({ invoke, from: { ref: 'authenticated-account', user: 'member', name: 'Member' }, things: [], note, where: 'Files', screen: '', browser: '', more: { kind: 'friction' }, capture: { submission_id: 'task:1', execution_ref: 'execution:1', origin: 'synthetic' }, at: '2026-10-08T03:00:00.000Z', sent_by: 'ai', harness: 'Codex', their_words: 'their words' });

// The caller keeps what each plan says, in the order the plan gives. This stands in for the store the recipe proves.
function caller() {
  const lists = new Map();
  const rows = new Map();
  const files = new Map();
  const notices = [];
  return {
    lists, rows, files, notices,
    async hand(message, { work = async () => ({ handoff: { handoff_id: 'work:1' } }) } = {}) {
      const address = handoffs.handOffAddress(message.invoke, message);
      const plan = handoffs.planHandOff(tools, { keptList: lists.get(address.list_id) ?? null, previous: rows.get(address.source_ref) ?? null, message });
      if (plan.list?.create) lists.set(address.list_id, plan.list.create);
      if (plan.list?.add_fields) lists.set(address.list_id, { ...lists.get(address.list_id), fields: plan.list.add_fields });
      if (plan.picture) files.set(plan.picture.name, plan.picture.bytes);
      if (plan.row) rows.set(address.source_ref, plan.row.values);
      notices.push(plan.notice);
      let workRef = null;
      if (plan.work) {
        const done = await work(plan.work);
        workRef = done?.handoff?.handoff_id ?? null;
      }
      const { joins, result } = handoffs.finishHandOff(plan, { workRef });
      if (joins) rows.set(address.source_ref, { ...rows.get(address.source_ref), ...joins.values });
      return result;
    },
  };
}

test('a report is kept once; a retry restores only the missing work join and keeps the review, the outcome and the original report', async () => {
  const store = caller();
  await assert.rejects(store.hand(report(), { work: async () => { throw new Error('work unavailable'); } }), /work unavailable/);
  assert.equal(store.rows.size, 1);
  const [sourceRef] = store.rows.keys();
  assert.equal(store.rows.get(sourceRef).note, 'Original report');
  assert.equal(store.rows.get(sourceRef).intake_state, 'received');
  store.rows.set(sourceRef, { ...store.rows.get(sourceRef), review: 'approved', outcome: 'kept outcome' });
  const kept = await store.hand(report());
  const after = store.rows.get(sourceRef);
  assert.equal(after.review, 'approved');
  assert.equal(after.outcome, 'kept outcome');
  assert.equal(after.note, 'Original report');
  assert.equal(after.harness, 'Codex');
  assert.equal(after.sent_by, 'ai');
  assert.equal(after.their_words, 'their words');
  assert.equal(after.work_ref, 'work:1');
  assert.equal(after.intake_state, 'work_created');
  assert.equal(kept.work_ref, 'work:1');
  assert.equal(kept.source_ref, sourceRef);
  assert.equal(store.notices.length, 2, 'every receipt is told, and the notice key makes a repeat a no-op at the notice owner');
  assert.equal(store.rows.size, 1);
  assert.throws(() => handoffs.planHandOff(tools, { keptList: store.lists.get(invoke.list.id), previous: after, message: report('different report') }), /different report/);
  assert.throws(() => handoffs.planHandOff(tools, { keptList: null, previous: null, message: { ...report(), invoke: { ...invoke, said: 'forged' } } }), /not one the platform sends/);
  assert.equal(store.rows.get(sourceRef).note, 'Original report');
});

test('the first report keeps its picture once, names the planned file, and a replay plans no second picture', async () => {
  const store = caller();
  const message = { ...report(), things: [{ kind: 'screen', label: 'Decisions' }], picture: { name: 'shot.png', media_type: 'image/png', bytes: new Uint8Array([1, 2, 3]) } };
  const first = handoffs.planHandOff(tools, { keptList: null, previous: null, message });
  assert.match(first.picture.name, new RegExp(`^${invoke.picture_folder}/submission-[0-9a-f]+ shot\\.png$`));
  assert.deepEqual([...first.picture.bytes], [1, 2, 3]);
  await store.hand(message);
  const second = handoffs.planHandOff(tools, { keptList: store.lists.get(invoke.list.id), previous: [...store.rows.values()][0], message });
  assert.equal(second.picture, null, 'a replay with the picture already kept plans no second file');
  assert.equal(second.row, null, 'a replay plans no first row');
});

test('an arrival-time report with no submission is kept under its time, and a list that gained a field gets it added only', async () => {
  const store = caller();
  const bare = { ...report(), capture: { origin: 'real' } };
  const result = await store.hand(bare);
  assert.match(result.row_id, /^2026-10-08T03-00-00-000Z-/);
  assert.equal(result.replay_coverage, 'arrival_time_only');
  const extended = { ...invoke, list: { ...invoke.list, fields: [...invoke.list.fields, { id: 'new_detail', kind: 'text', label: 'New detail' }] } };
  const plan = handoffs.planHandOff([{ invoke: extended }], { keptList: { id: invoke.list.id, fields: invoke.list.fields }, previous: null, message: { ...bare, invoke: extended } });
  assert.equal(plan.list.add_fields.length, invoke.list.fields.length + 1);
  assert.deepEqual(plan.list.add_fields.slice(0, invoke.list.fields.length), invoke.list.fields);
});

test('a managed submission needs its authenticated sending account, and the sender side names a real account only', async () => {
  assert.throws(() => handoffs.planHandOff(tools, { keptList: null, previous: null, message: { ...report(), from: { user: 'member' } } }), /authenticated sending account/);
  const sent = [];
  const action = handoffs.handToAccountActions({
    recipients: { OPERATOR_ACCOUNT_ID: 'operator' },
    identity: { ref: 'member-ref', user: async () => 'member', name: async () => 'Member' },
    readPicture: async () => { throw new Error('no picture'); },
    receive: async message => { sent.push(['own', message]); return { kept: true }; },
    deliver: async (account, message) => { sent.push([account, message]); return { kept: true }; },
    recordJourney: async () => {},
    reportKindOf: value => value,
  })['hand-to-an-account'];
  const invocation = { ...invoke, to: { setting: 'OPERATOR_ACCOUNT_ID' }, said: 'Sent. Thank you.' };
  const answer = await action({ note: 'Something broke', kind: 'bug' }, invocation, { sentBy: 'ai', harness: 'Codex', theirWords: 'words', task: { task_id: 'task:2' } });
  assert.equal(answer.said, 'Sent. Thank you.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'operator');
  assert.equal(sent[0][1].note, 'Something broke');
  await assert.rejects(action({ note: 'x' }, { ...invocation, to: { setting: 'ANY_SETTING' } }), /does not name an account/);
});
