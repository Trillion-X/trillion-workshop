// The hand-over code and the static items, run as the container runs them with the records handed in: a code is shown once and
// kept only as its hash; used once it hands the space over; used again it is refused; a lapsed code is refused; only the owner
// hands over or moves items. The test stores each `keep` back the way the caller would. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import { handOverASpace, moveStaticItemsIntoASpace, takeOverASpace } from '../do-work/space-members.mjs';
import { KINDS, rowId } from '../read-data/space-rows.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const OWNER = 'owner@example.com';
const BO = 'bo@example.com';
const ANA = 'ana@example.com';
const spaceRow = { type: KINDS.space, id: rowId('space', 'club'), value: { title: 'Sample club', owner: OWNER, label: 'group', config: { join: [{ free: true }] } } };
const ownerRow = { type: KINDS.member, id: rowId('member', 'club', OWNER), value: { space: 'club', subject: OWNER, member_type: 'owner', state: 'member', how: 'owner', joined_at: '2026-01-01T00:00:00.000Z' } };
const applied = (records, keeps) => keeps.reduce((all, keep) => [...all.filter(record => record.id !== keep.id), { id: keep.id, type: keep.type, value: keep.value }], records);
const usedOrLapsed = /used or has expired/;

test('a code is shown once and kept only as its hash; a person who does not run the space cannot hand it over', () => {
  const made = handOverASpace({ space: 'club', subject: OWNER, records: [spaceRow, ownerRow] });
  assert.equal(made.code.length, 48);
  assert.equal(made.keep.length, 1);
  assert.equal(made.keep[0].type, KINDS.handover);
  assert.equal(made.keep[0].id, rowId('handover', 'club', makeHashCodeHexFromBytes(new TextEncoder().encode(made.code))));
  assert.equal(JSON.stringify(made.keep).includes(made.code), false);
  assert.throws(() => handOverASpace({ space: 'club', subject: BO, records: [spaceRow, ownerRow] }), /Only the person who runs/);
});

test('a live code used once hands the space over: the owner becomes a member and the new person the owner', () => {
  const made = handOverASpace({ space: 'club', subject: OWNER, records: [spaceRow, ownerRow] });
  const after = applied([spaceRow, ownerRow, ...made.keep], []).concat();
  const taken = takeOverASpace({ space: 'club', subject: BO, code: made.code, records: after });
  assert.equal(taken.owner, true);
  assert.equal(taken.previous_owner, OWNER);
  const next = applied(after, taken.keep);
  assert.equal(next.find(record => record.id === rowId('space', 'club')).value.owner, BO);
  assert.equal(next.find(record => record.id === rowId('member', 'club', OWNER)).value.member_type, 'member');
  assert.equal(next.find(record => record.id === rowId('member', 'club', BO)).value.member_type, 'owner');
  assert.equal(next.find(record => record.type === KINDS.handover).value.used_at !== null, true);
});

test('used again the same code is refused in the words for a lapsed link', () => {
  const made = handOverASpace({ space: 'club', subject: OWNER, records: [spaceRow, ownerRow] });
  const after = applied([spaceRow, ownerRow, ...made.keep], []);
  const once = takeOverASpace({ space: 'club', subject: BO, code: made.code, records: after });
  const next = applied(after, once.keep);
  assert.throws(() => takeOverASpace({ space: 'club', subject: ANA, code: made.code, records: next }), usedOrLapsed);
});

test('a lapsed code is refused, and a wrong code is refused as lapsed', () => {
  const made = handOverASpace({ space: 'club', subject: OWNER, records: [spaceRow, ownerRow] });
  const lapsed = made.keep.map(row => ({ ...row, value: { ...row.value, expires_at: '2020-01-01T00:00:00.000Z' } }));
  assert.throws(() => takeOverASpace({ space: 'club', subject: BO, code: made.code, records: [spaceRow, ownerRow, ...lapsed] }), usedOrLapsed);
  assert.throws(() => takeOverASpace({ space: 'club', subject: BO, code: 'not-a-code', records: [spaceRow, ownerRow, ...made.keep] }), usedOrLapsed);
});

test('static items move into the space once: the owner moves them, asking again keeps nothing, and others are refused', () => {
  const projection = { items: [{ item_ref: 'page-1', created_at: '2026-02-01T00:00:00.000Z', fields: { text: 'Welcome' } }, { item_ref: 'page-2', created_at: '2026-02-02T00:00:00.000Z', fields: { text: 'Rules' } }] };
  const moved = moveStaticItemsIntoASpace({ space: 'club', subject: OWNER, source: 'bitfield-group-page-2026', projection, records: [spaceRow, ownerRow] });
  assert.equal(moved.moved, 2);
  assert.equal(moved.keep.length, 2);
  assert.equal(moved.keep[0].value.from_static, 'bitfield-group-page-2026');
  const again = moveStaticItemsIntoASpace({ space: 'club', subject: OWNER, source: 'bitfield-group-page-2026', projection, records: [spaceRow, ownerRow, ...moved.keep] });
  assert.equal(again.keep, undefined);
  assert.throws(() => moveStaticItemsIntoASpace({ space: 'club', subject: BO, source: 'x', projection, records: [spaceRow, ownerRow] }), /Only the person who runs/);
});

test('the four new tool rows sit with the membership rows and run their functions', () => {
  const expect = { 'tool:hand-over-a-space': 'handOverASpace', 'tool:take-over-a-space': 'takeOverASpace', 'tool:move-static-items-into-a-space': 'moveStaticItemsIntoASpace' };
  for (const [id, fn] of Object.entries(expect)) {
    const row = rows.records.find(record => record.payload.id === id);
    assert.ok(row, `${id} exists`);
    assert.equal(row.payload.invoke.argv.at(-1), fn);
  }
});
