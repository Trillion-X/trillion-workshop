// Ported from the package's organizer-event cases, with a made-up bakery club in place of the original community.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAnEvent } from '../read-data/plan-an-event.ts';

const draft = {
  idempotency_key: 'a8b0d0bfea434a4583182715150e1725',
  host_group_ref: 'group:bakery-club',
  event_label: 'Sourdough Saturday',
  focus_label: 'Fix one flat loaf',
  public_summary: 'Bring one flat loaf and leave knowing why.',
  detail_intro: 'A small baking morning for people who bake together.',
  schedule_intent: 'weekend morning',
  primary_starts_at: '2026-09-12T09:00',
  primary_ends_at: '2026-09-12T11:00',
  alternate_starts_at: '2026-09-13T09:00',
  alternate_ends_at: '2026-09-13T11:00',
  time_zone: 'America/Chicago',
  place_label: 'The long table',
  mode: 'in person',
  visibility: 'members only',
  capacity: 12,
  host_origin: 'https://club.example.test',
  workflow_definition_ref: 'workflow:event-signup',
};
const KEY = draft.idempotency_key;

test('a draft becomes a session, a catalog entry, the capacity ledger to open, and the address', () => {
  const plan = planAnEvent(draft);
  assert.equal(plan.session.session_id, `session:${KEY}`);
  assert.deepEqual(plan.session.candidate_occurrences.map(item => item.occurrence_id), [`occurrence:${KEY}:primary`, `occurrence:${KEY}:alternate`]);
  assert.equal(plan.session.candidate_places[0].choice_descriptor.data.label, 'The long table');
  assert.equal(plan.session.candidate_modes[0].key, 'mode:in-person');
  assert.equal(plan.session.candidate_modes[0].data.label, 'in person');
  assert.equal(plan.session.participation_policy.visibility_predicate_ref, 'visibility:members-only');
  assert.deepEqual(plan.catalog_entry.owning_group_refs, ['group:bakery-club']);
  assert.equal(plan.catalog_entry.catalog_visibility_predicate.policy_ref, 'visibility:members-only');
  assert.deepEqual(plan.capacity_ledger, { ledger_id: `ledger:${KEY}`, scope_ref: `session:${KEY}`, total: 12, policy_ref: plan.session.capacity_plan.capacity_policy_ref });
  assert.equal(plan.session.capacity_plan.seat_ledger_ref, plan.capacity_ledger.ledger_id);
  assert.equal(plan.session.lifecycle_state.key, 'draft');
  assert.equal(plan.share_url, `https://club.example.test/events/${KEY}`);
  assert.equal(plan.preview_path, `/events?preview=${KEY}`);
});

test('a retry gives the same plan, and a half-given alternate is refused', () => {
  assert.deepEqual(planAnEvent(draft), planAnEvent(draft));
  assert.throws(() => planAnEvent({ ...draft, alternate_starts_at: '2026-09-14T09:00', alternate_ends_at: '' }), /alternate occurrence requires both starts_at and ends_at/);
  const noAlternate = planAnEvent({ ...draft, alternate_starts_at: undefined, alternate_ends_at: undefined, place_label: '' });
  assert.equal(noAlternate.session.candidate_occurrences.length, 1);
  assert.deepEqual(noAlternate.session.candidate_places, []);
});

test('any language and any mode or visibility word works without a branch', () => {
  const plan = planAnEvent({ ...draft, event_label: '夜の制作時間', focus_label: '次の一歩', place_label: 'オンライン', mode: 'オンライン', visibility: '公開', host_origin: 'http://localhost:4178', lifecycle_state: 'interest open' });
  assert.equal(plan.session.purpose_contract.key, 'focus:次の一歩');
  assert.equal(plan.session.candidate_modes[0].key, 'mode:オンライン');
  assert.equal(plan.session.participation_policy.visibility_predicate_ref, 'visibility:公開');
  assert.equal(plan.session.lifecycle_state.key, 'interest-open');
  assert.equal(plan.share_url, `http://localhost:4178/events/${KEY}`);
});

test('render ids, unsafe routes, non-web origins and bad times are refused in words', () => {
  assert.throws(() => planAnEvent({ ...draft, idempotency_key: ':r0:' }), /128-bit/);
  for (const catalog_path of ['//other.example', '/events/../private', '/events/%2e%2e', '/events?token=x']) {
    assert.throws(() => planAnEvent({ ...draft, catalog_path }), /catalog_path/);
  }
  assert.equal(planAnEvent({ ...draft, catalog_path: '/classes/' }).live_path, `/classes/${KEY}`);
  assert.throws(() => planAnEvent({ ...draft, host_origin: 'ftp://localhost' }), /https/);
  assert.throws(() => planAnEvent({ ...draft, host_origin: 'https://user:pw@club.example.test' }), /credentials/);
  assert.throws(() => planAnEvent({ ...draft, host_origin: 'https://club.example.test/path' }), /credentials, query, or fragment/);
  assert.throws(() => planAnEvent({ ...draft, host_group_ref: '' }), /host_group_ref/);
  assert.throws(() => planAnEvent({ ...draft, workflow_definition_ref: '' }), /workflow_definition_ref/);
  assert.throws(() => planAnEvent({ ...draft, primary_ends_at: '2026-09-12T08:00' }), /end after/);
  assert.throws(() => planAnEvent({ ...draft, primary_starts_at: '2026-02-30T09:00' }), /valid local/);
  assert.throws(() => planAnEvent({ ...draft, time_zone: 'Not/AZone' }), /Invalid time zone/);
  for (const capacity of [0, 1.5, 1_000_001, 'many']) assert.throws(() => planAnEvent({ ...draft, capacity }), /capacity must be an integer/);
  assert.throws(() => planAnEvent({ ...draft, mode: ' ' }), /mode must be a non-empty string/);
});
