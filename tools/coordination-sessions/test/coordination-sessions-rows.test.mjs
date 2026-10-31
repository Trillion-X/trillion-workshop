// The rows run as the container runs them. Every name is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const step = rowOf(rows, 'tool:run-a-session-step');
const catalog = rowOf(rows, 'tool:work-a-session-catalog');
const plan = rowOf(rows, 'tool:plan-an-event');

const session = id => ({
  session_id: id,
  purpose_contract: { key: 'baking-morning', descriptor_ref: 'purpose:baking-morning' },
  candidate_occurrences: [{ occurrence_id: `${id}:1`, starts_at: '2026-09-12T09:00', ends_at: '2026-09-12T11:00', time_zone: 'America/Chicago', calendar_system: 'gregorian' }],
  candidate_places: [],
  candidate_modes: [{ key: 'mode:in-person', descriptor_ref: 'mode:in-person' }],
  capacity_plan: { capacity_policy_ref: 'capacity-policy:one', seat_ledger_ref: `ledger:${id}` },
  participation_policy: { visibility_predicate_ref: 'visibility:members', eligibility_predicate_ref: 'eligible:members' },
  lifecycle_state: { key: 'draft', descriptor_ref: 'lifecycle:draft' },
  workflow_definition_ref: 'workflow:signup',
  participant_provenance: [{ provenance_id: `p:${id}`, subject_ref: 'person:ana', source_session_id: id, participant_relation_ref: 'relation:guest' }],
  preference_provenance: [],
});
const ok = async (row, input) => {
  const answer = await runRow(row, input);
  assert.equal(answer.status, 0, answer.error);
  return answer.result;
};
const refused = async (row, input) => {
  const answer = await runRow(row, input);
  assert.equal(answer.status, 1);
  return answer.error;
};

test('a session is created, confirmed, forked and superseded, and each answer keeps its lineage', async () => {
  const created = await ok(step, { operation: 'create', session: session('session:one') });
  assert.equal(created.session.fork_merge_provenance.operation, 'create');
  const confirmed = await ok(step, { operation: 'confirm', session: created.session, lifecycle_state: { key: 'confirmed', descriptor_ref: 'lifecycle:confirmed' } });
  assert.equal(confirmed.session.lifecycle_state.key, 'confirmed');
  const forked = await ok(step, { operation: 'fork', session: confirmed.session, fork: { session_id: 'session:two', lifecycle_state: { key: 'draft', descriptor_ref: 'lifecycle:draft' } } });
  assert.deepEqual(forked.session.fork_merge_provenance.lineage_session_ids, ['session:one', 'session:two']);
  assert.deepEqual(forked.session.participant_provenance.map(item => item.subject_ref), ['person:ana']);
  const superseded = await ok(step, { operation: 'supersede', session: forked.session, supersede: { session_id: 'session:three', lifecycle_state: { key: 'draft', descriptor_ref: 'lifecycle:draft' }, predecessor_lifecycle_state: { key: 'superseded', descriptor_ref: 'lifecycle:superseded' } } });
  assert.equal(superseded.successor.supersedes_ref, 'session:two');
  assert.equal(superseded.predecessor.lifecycle_state.key, 'superseded');
});

test('a step that is not named, a merge of one session, and a session missing a field are refused in words', async () => {
  assert.match(await refused(step, { operation: 'made_up', session: session('session:one') }), /unsupported coordination-session lifecycle operation: made_up/);
  assert.match(await refused(step, { operation: 'merge', sessions: [session('session:one')], merge: { session_id: 'x', lifecycle_state: { key: 'a', descriptor_ref: 'b' } } }), /at least two/);
  assert.match(await refused(step, { operation: 'create', session: { ...session('session:one'), workflow_definition_ref: '' } }), /workflow_definition_ref must be a non-empty string/);
});

test('a catalog entry is published, replaced and withdrawn, and only the current ones are read', async () => {
  const entry = id => ({ catalog_entry_id: id, owning_group_refs: ['group:club'], session_refs: ['session:one'], catalog_visibility_predicate: { policy_ref: 'visibility:members' }, recommendation_policy_ref: `recommend:${id}`, cross_offer_policy: [], presentation_surface_refs: ['surface:web', 'surface:web'] });
  const one = (await ok(catalog, { operation: 'publish', entry: entry('catalog:one') })).entry;
  assert.deepEqual(one.presentation_surface_refs, ['surface:web']);
  const two = (await ok(catalog, { operation: 'publish', entry: entry('catalog:two') })).entry;
  const swapped = await ok(catalog, { operation: 'supersede', predecessor: one, successor: two });
  assert.equal(swapped.predecessor.superseded_by, 'catalog:two');
  const withdrawn = (await ok(catalog, { operation: 'retract', entry: two, reason_ref: 'reason:full' })).entry;
  assert.match(withdrawn.retracted_at, /^\d{4}-\d{2}-\d{2}T/);
  const three = (await ok(catalog, { operation: 'publish', entry: entry('catalog:three') })).entry;
  const read = await ok(catalog, { operation: 'read', entries: [swapped.predecessor, withdrawn, three] });
  assert.deepEqual(read.entries.map(item => item.catalog_entry_id), ['catalog:three']);
  const crossed = (await ok(catalog, { operation: 'cross_offer', entry: three, relation: { target_catalog_entry_ref: 'catalog:one', relation_descriptor_ref: 'relation:related' } })).entry;
  assert.equal(crossed.cross_offer_policy.length, 1);
  assert.match(await refused(catalog, { operation: 'constructor' }), /There is no catalog operation "constructor"\. The operations are: publish, read, update, retract, supersede, cross_offer\./);
  assert.match(await refused(catalog, { operation: 'update', entry: three }), /patch is required for this operation/);
});

test('an event is planned from a draft, and a bad draft says what to fix', async () => {
  const draft = {
    idempotency_key: 'a8b0d0bfea434a4583182715150e1725', host_group_ref: 'group:bakery-club', event_label: 'Sourdough Saturday', focus_label: 'Fix one flat loaf',
    public_summary: 'Bring one flat loaf.', detail_intro: 'A small baking morning.', schedule_intent: 'weekend morning',
    primary_starts_at: '2026-09-12T09:00', primary_ends_at: '2026-09-12T11:00', time_zone: 'America/Chicago', mode: 'in person', visibility: 'members only',
    capacity: 12, host_origin: 'https://club.example.test', workflow_definition_ref: 'workflow:event-signup',
  };
  const planned = await ok(plan, draft);
  assert.equal(planned.capacity_ledger.total, 12);
  assert.equal(planned.capacity_ledger.ledger_id, planned.session.capacity_plan.seat_ledger_ref);
  assert.equal(planned.share_url, 'https://club.example.test/events/a8b0d0bfea434a4583182715150e1725');
  assert.deepEqual(await ok(plan, draft), planned);
  assert.match(await refused(plan, { ...draft, host_origin: 'http://club.example.test' }), /host_origin must use https/);
  assert.match(await refused(plan, { ...draft, capacity: 0 }), /capacity must be an integer/);
});
