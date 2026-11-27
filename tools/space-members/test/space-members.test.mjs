// The membership rows run as the container runs them, with the records they read handed in and no door: each answers the
// rows to store under `keep` and keeps nothing itself; the test stores `keep` back, as the caller's AI would:
// a person joins by a free row or by holding access, a refund lapses them the very next ask and new access brings them
// back with nothing written in between, a space with no join rows is joined only by invitation, and asking twice writes
// nothing. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
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
// What the caller does: the records it read, with what an answer says to store put over them by id.
const stored = (records, answer) => [...records.filter(one => !(answer.result.keep ?? []).some(row => row.id === one.id)), ...(answer.result.keep ?? [])];
const run = (row, input, records) => answerOf(row, { ...input, records });

test('a free row lets a person in once; the member row comes back under keep and nothing is stored; asking again with it stored answers nothing to keep', async () => {
  const records = [space([{ free: true }]), owner];
  const first = await run(join, { space: 'sample-club', subject: ANA, name: 'Ana' }, records);
  assert.equal(first.status, 0, first.error);
  const { keep, ...said } = first.result;
  assert.deepEqual(said, { space: 'sample-club', subject: ANA, joined: true, state: 'member', member_type: 'member', how: 'free' });
  assert.equal(memberOf(keep).name, 'Ana');
  assert.equal(keep.length, 1, 'one row comes back under keep');
  assert.equal(keep[0].expected, null, 'a new member row expects no record there');
  const second = await run(join, { space: 'sample-club', subject: ANA }, stored(records, first));
  assert.equal(second.result.joined, false);
  assert.equal(second.result.keep, undefined, 'the second ask has nothing to keep');
});

test('a space with no join rows is joined only by invitation, and the refusal says so in words', async () => {
  const answer = await run(join, { space: 'sample-club', subject: ANA }, [space(undefined), owner]);
  assert.notEqual(answer.status, 0);
  assert.match(answer.error, /joined by invitation only/);
});

test('a paid row admits a person who holds the access, refuses one who does not, lapses them on refund and brings them back', async () => {
  const gate = space([{ access: 'access:sample-course' }]);
  const without = await run(join, { space: 'sample-club', subject: ANA }, [gate, owner, offer]);
  assert.notEqual(without.status, 0);
  assert.match(without.error, /Join by holding the access access:sample-course/);

  const joined = await run(join, { space: 'sample-club', subject: ANA }, [gate, owner, offer, paid]);
  assert.equal(joined.status, 0, joined.error);
  assert.equal(joined.result.how, 'access:access:sample-course');

  const kept = stored([gate, owner, offer, paid], joined);
  const refunded = await run(check, { space: 'sample-club', subject: ANA }, [...kept, refund]);
  assert.equal(refunded.result.state, 'lapsed');
  assert.equal(refunded.result.member, false);
  assert.match(refunded.result.reason, /ended/);
  assert.equal(refunded.result.keep, undefined, 'nothing is answered to keep by the lapse');

  const back = await run(check, { space: 'sample-club', subject: ANA }, kept);
  assert.equal(back.result.state, 'member');
});

test('a member leaves and may join again; the person who runs the space cannot leave', async () => {
  const records = [space([{ free: true }]), owner];
  const joined = await run(join, { space: 'sample-club', subject: ANA }, records);
  const left = await run(leave, { space: 'sample-club', subject: ANA }, stored(records, joined));
  assert.equal(left.result.left, true);
  assert.equal(memberOf(left.result.keep).state, 'left');
  const again = await run(join, { space: 'sample-club', subject: ANA }, stored(stored(records, joined), left));
  assert.equal(again.result.joined, true);
  const stuck = await run(leave, { space: 'sample-club', subject: OWNER }, records);
  assert.match(stuck.error, /hand it over/);
});

test('a person a host put out stays out of a free space', async () => {
  const out = record('record:space-member', rowId('member', 'sample-club', ANA), { space: 'sample-club', subject: ANA, member_type: 'member', state: 'removed', how: 'free', joined_at: '2026-01-02T00:00:00.000Z' });
  const answer = await run(join, { space: 'sample-club', subject: ANA }, [space([{ free: true }]), owner, out]);
  assert.match(answer.error, /put out/);
});

test('only a current member lists the members; the list shows names, types and state, never a contact', async () => {
  const records = [space([{ free: true }]), owner];
  const joined = await run(join, { space: 'sample-club', subject: ANA, name: 'Ana' }, records);
  const kept = stored(records, joined);
  const shown = await run(list, { space: 'sample-club', subject: OWNER }, kept);
  assert.deepEqual(shown.result.members.map(row => [row.name, row.member_type, row.member_type_label, row.state]), [[null, 'owner', 'Owner', 'member'], ['Ana', 'member', 'Member', 'member']]);
  assert.ok(shown.result.members.every(row => !('subject' in row)), 'no contact is shown');
  const stranger = await run(list, { space: 'sample-club', subject: BO }, kept);
  assert.match(stranger.error, /Only members of Sample club/);
});

test('a member chooses the name they show and the row comes back under keep; a stranger cannot', async () => {
  const records = [space([{ free: true }]), owner];
  const named = await run(naming, { space: 'sample-club', subject: OWNER, name: 'Sample Owner' }, records);
  assert.equal(named.result.name, 'Sample Owner');
  assert.equal(named.result.keep.length, 1);
  assert.equal(named.result.keep[0].id, rowId('member', 'sample-club', OWNER));
  assert.equal(named.result.keep[0].value.name, 'Sample Owner');
  assert.deepEqual(named.result.keep[0].expected, owner, 'the row expects the record it was handed in, so a store refuses it if that record moved');
  const stranger = await run(naming, { space: 'sample-club', subject: BO, name: 'Bo' }, records);
  assert.notEqual(stranger.status, 0);
});

test('the space\'s own words replace the standard ones', async () => {
  const mine = space([{ access: 'access:sample-course' }], { config: { join: [{ access: 'access:sample-course' }], words: { refused: 'Members only. {how}' } } });
  const answer = await run(join, { space: 'sample-club', subject: ANA }, [mine, owner, offer]);
  assert.match(answer.error, /^Members only\./);
});

test('no row holds a records right', () => {
  for (const one of [join, leave, check, list, naming]) {
    assert.equal(one.invoke.records, undefined, `${one.id} is handed no door`);
    assert.ok(!JSON.stringify(one.invoke).includes('records-door'), `${one.id} names no records door`);
  }
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
