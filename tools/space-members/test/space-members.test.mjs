// The membership rows run as the container runs them, against the stand-in records door with exactly each row's rights:
// a person joins by a free row or by holding access, a refund lapses them the very next ask and new access brings them
// back with nothing written in between, a space with no join rows is joined only by invitation, and asking twice writes
// nothing. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { admission, joinRowProblems, memberNow } from '../read-data/member-now.mjs';
import { inheritedMemberTypes, joinsAs, memberTypesOf } from '../read-data/member-types.mjs';
import { rowId } from '../read-data/space-rows.mjs';

const join = rowOf(rows, 'tool:join-a-space');
const leave = rowOf(rows, 'tool:leave-a-space');
const check = rowOf(rows, 'tool:check-someone-is-in-a-space');
const list = rowOf(rows, 'tool:list-a-spaces-members');
const naming = rowOf(rows, 'tool:choose-the-name-i-show-in-a-space');

const OWNER = 'owner@example.com';
const ANA = 'ana@example.com';
const BO = 'bo@example.com';
const record = (type, id, value) => ({ type, id, value });
const space = (join, extra = {}) => record('record:space', 'record:space:sample-club', { title: 'Sample club', owner: OWNER, config: { join }, ...extra });
const owner = record('record:space-member', rowId('member', 'sample-club', OWNER), { space: 'sample-club', subject: OWNER, member_type: 'owner', state: 'member', how: 'owner', joined_at: '2026-01-01T00:00:00.000Z' });
const offer = record('record:commercial-offer', 'offer:class', { id: 'offer:class', access_refs: ['access:sample-course'], price_options: [{ id: 'price:class', amount_cents: 9000 }] });
const paid = record('payment-event', 'payment-event:evt_1', { event_id: 'evt_1', event_kind: 'payment.confirmed', occurred_at: '2026-03-01T00:00:00.000Z', attributes: { provider_event_id: 'evt_1', customer_email: ANA, offer_id: 'offer:class', payment_intent_ref: 'pi_1', payment_status: 'paid' } });
const refund = record('payment-event', 'payment-event:evt_2', { event_id: 'evt_2', event_kind: 'payment.refunded', occurred_at: '2026-03-02T00:00:00.000Z', attributes: { provider_event_id: 'evt_2', provider_object_ref: 'ch_1', payment_intent_ref: 'pi_1' } });
const memberOf = kept => kept.find(item => item.id === rowId('member', 'sample-club', ANA))?.value;

test('a free row lets a person in once; asking again writes nothing; they get the type their label starts joiners with', async () => {
  const first = await answerOf(join, { space: 'sample-club', subject: ANA, name: 'Ana' }, { records: [space([{ free: true }]), owner] });
  assert.equal(first.status, 0, first.error);
  assert.deepEqual(first.result, { space: 'sample-club', subject: ANA, joined: true, state: 'member', member_type: 'member', how: 'free' });
  assert.equal(memberOf(first.kept).name, 'Ana');
  const second = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: first.kept });
  assert.equal(second.result.joined, false);
  assert.ok(!second.calls.some(call => call.method === 'records:write'), 'the second ask writes nothing');
});

test('a space with no join rows is joined only by invitation, and the refusal says so in words', async () => {
  const answer = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: [space(undefined), owner] });
  assert.notEqual(answer.status, 0);
  assert.match(answer.error, /joined by invitation only/);
});

test('a paid row admits a person who holds the access, refuses one who does not, lapses them on refund and brings them back', async () => {
  const gate = space([{ access: 'access:sample-course' }]);
  const without = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: [gate, owner, offer] });
  assert.notEqual(without.status, 0);
  assert.match(without.error, /Join by holding the access access:sample-course/);

  const joined = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: [gate, owner, offer, paid] });
  assert.equal(joined.status, 0, joined.error);
  assert.equal(joined.result.how, 'access:access:sample-course');

  const refunded = await answerOf(check, { space: 'sample-club', subject: ANA }, { records: [...joined.kept, refund] });
  assert.equal(refunded.result.state, 'lapsed');
  assert.equal(refunded.result.member, false);
  assert.match(refunded.result.reason, /ended/);
  assert.deepEqual(refunded.kept, [...joined.kept, refund].map(item => ({ ...item })), 'nothing was written by the lapse');

  const back = await answerOf(check, { space: 'sample-club', subject: ANA }, { records: [...joined.kept, paid] });
  assert.equal(back.result.state, 'member');
});

test('a member leaves and may join again; the person who runs the space cannot leave', async () => {
  const records = [space([{ free: true }]), owner];
  const joined = await answerOf(join, { space: 'sample-club', subject: ANA }, { records });
  const left = await answerOf(leave, { space: 'sample-club', subject: ANA }, { records: joined.kept });
  assert.equal(left.result.left, true);
  assert.equal(memberOf(left.kept).state, 'left');
  const again = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: left.kept });
  assert.equal(again.result.joined, true);
  const stuck = await answerOf(leave, { space: 'sample-club', subject: OWNER }, { records });
  assert.match(stuck.error, /hand it over/);
});

test('a person a host put out stays out of a free space', async () => {
  const out = record('record:space-member', rowId('member', 'sample-club', ANA), { space: 'sample-club', subject: ANA, member_type: 'member', state: 'removed', how: 'free', joined_at: '2026-01-02T00:00:00.000Z' });
  const answer = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: [space([{ free: true }]), owner, out] });
  assert.match(answer.error, /put out/);
});

test('only a current member lists the members; the list shows names, types and state, never a contact', async () => {
  const records = [space([{ free: true }]), owner];
  const joined = await answerOf(join, { space: 'sample-club', subject: ANA, name: 'Ana' }, { records });
  const shown = await answerOf(list, { space: 'sample-club', subject: OWNER }, { records: joined.kept });
  assert.deepEqual(shown.result.members.map(row => [row.name, row.member_type, row.member_type_label, row.state]), [[null, 'owner', 'Owner', 'member'], ['Ana', 'member', 'Member', 'member']]);
  assert.ok(shown.result.members.every(row => !('subject' in row)), 'no contact is shown');
  const stranger = await answerOf(list, { space: 'sample-club', subject: BO }, { records: joined.kept });
  assert.match(stranger.error, /Only members of Sample club/);
});

test('a member chooses the name they show; a stranger cannot', async () => {
  const records = [space([{ free: true }]), owner];
  const named = await answerOf(naming, { space: 'sample-club', subject: OWNER, name: 'Sample Owner' }, { records });
  assert.equal(named.result.name, 'Sample Owner');
  const stranger = await answerOf(naming, { space: 'sample-club', subject: BO, name: 'Bo' }, { records });
  assert.notEqual(stranger.status, 0);
});

test('the space\'s own words replace the standard ones', async () => {
  const mine = space([{ access: 'access:sample-course' }], { config: { join: [{ access: 'access:sample-course' }], words: { refused: 'Members only. {how}' } } });
  const answer = await answerOf(join, { space: 'sample-club', subject: ANA }, { records: [mine, owner, offer] });
  assert.match(answer.error, /^Members only\./);
});

test('the join reader: rows are DATA, any row that holds admits, a row the DATA does not name admits nobody', () => {
  const s = config => ({ title: 'S', owner: OWNER, config });
  assert.deepEqual(admission(s({ join: [{ free: true }] })), { admitted: true, how: 'free' });
  assert.deepEqual(admission(s({}), { invited: true }), { admitted: true, how: 'invited' });
  assert.deepEqual(admission(s({}), {}), { admitted: false, how: null });
  assert.deepEqual(admission(s({ join: [{ access: 'a' }, { access: 'b' }] }), { held_access: ['b'] }), { admitted: true, how: 'access:b' });
  assert.deepEqual(admission(s({ join: [{ nonsense: true }] })), { admitted: false, how: null });
  assert.equal(joinRowProblems([{ free: true }, { access: 'x' }]).length, 0);
  assert.equal(joinRowProblems([{ free: false }]).length, 1);
  assert.equal(joinRowProblems([]).length, 1);
  assert.equal(memberNow({ space: s({ join: [{ free: true }] }), subject: OWNER, member: { state: 'member' } }).member, true);
  assert.equal(memberNow({ space: s({ join: [{ access: 'a' }] }), subject: OWNER, member: { state: 'member' } }).member, true, 'the owner counts whatever the rows say');
});

test('member types: the label starts people as its profile says, the space adds its own, a cycle or a missing parent is refused', () => {
  const group = { label: 'group', config: {} };
  assert.equal(joinsAs(group), 'member');
  assert.equal(joinsAs({ label: 'project', config: {} }), 'contributor');
  assert.equal(joinsAs({ label: 'group', config: { joins_as: 'guest' } }), 'guest');
  const mine = { label: 'group', config: { own_types: [{ id: 'coach', label: 'Coach', inherits: ['member'] }] } };
  assert.deepEqual(inheritedMemberTypes(memberTypesOf(mine), 'coach'), ['member', 'coach']);
  assert.throws(() => memberTypesOf({ label: 'group', config: { own_types: [{ id: 'a', label: 'A', inherits: ['b'] }, { id: 'b', label: 'B', inherits: ['a'] }] } }), /cycle/);
  assert.throws(() => memberTypesOf({ label: 'group', config: { own_types: [{ id: 'a', label: 'A', inherits: ['gone'] }] } }), /not in this space/);
});
