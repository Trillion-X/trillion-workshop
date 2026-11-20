// test/share-grant-input.test.mjs
// The share the Privacy screen keeps for letting someone use your read-only tools (src/view-as.mjs): the keep and withdraw inputs
// the engine's sharing.keep and sharing.withdraw read (trillion-rust src/account_rights/share_grant.rs, share-grant.json `act`),
// the link's bearer and its digest, the end rule from a day count, and the screen's send actions. The look sign-in is retired
// (Nov 20 2026 ruling, relayed by the lead) and is not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { endsAfterDays, sharingKeepInput, sharingSections, sharingWithdrawInput, shareLinkFor, ViewAsError, viewAsSettings } from '../src/view-as.mjs';

const digest = 'a'.repeat(64);
const person = { principal: 'sam_1', key_blake3: digest };
const tools = ['show-my-screens-from-a-catalogue-of-reads-and-layouts', 'read-my-trading-account-board'];

test('the keep is sharing.keep on @own-records with the label, the tools, identity none and journal input', () => {
  const kept = sharingKeepInput({ label: "Sam's read-only tools", tools, people: [person] });
  assert.deepEqual(kept, {
    resource: '@own-records',
    operation: 'sharing.keep',
    input: { label: "Sam's read-only tools", on: true, sharing: { grant: { tools, identity: 'none', journal: 'input' }, people: [person] } },
  });
});

test('an end rule is kept beside the grant as given, and only when the owner sets one', () => {
  const ends = { until: '2026-11-22T00:00:00.000Z' };
  assert.deepEqual(sharingKeepInput({ label: 'x', tools, people: [person], ends }).input.sharing.ends, ends);
  assert.equal('ends' in sharingKeepInput({ label: 'x', tools, people: [person] }).input.sharing, false, 'no rule, no ends field');
});

test('the engine caps are refused in the owner\'s words before anything is sent', () => {
  assert.throws(() => sharingKeepInput({ label: '', tools, people: [person] }), ViewAsError);
  assert.throws(() => sharingKeepInput({ label: 'x'.repeat(401), tools, people: [person] }), /1 to 400 bytes/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools: [], people: [person] }), /at least one tool/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: [] }), /at least one person/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: Array.from({ length: 65 }, (_, index) => ({ principal: `p${index}`, key_blake3: digest })) }), /no more than 64/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: [{ principal: 'has space', key_blake3: digest }] }), /at least one person/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: [{ principal: 'sam', key_blake3: 'not-a-digest' }] }), /at least one person/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: [person], identity: 'everyone' }), /none or the person/);
  assert.throws(() => sharingKeepInput({ label: 'x', tools, people: [person], journal: 'all' }), /input or none/);
});

test('stop is sharing.withdraw on @own-records with the label only', () => {
  assert.deepEqual(sharingWithdrawInput("Sam's read-only tools"), { resource: '@own-records', operation: 'sharing.withdraw', input: { label: "Sam's read-only tools" } });
});

test('the end rule from days is { until } that many days ahead, only 1, 3 or 7 days', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.deepEqual(endsAfterDays(3, now), { until: '2026-11-22T12:00:00.000Z' });
  assert.deepEqual(endsAfterDays('1', now), { until: '2026-11-20T12:00:00.000Z' });
  assert.throws(() => endsAfterDays(30, now), /Choose 1, 3 or 7 days/);
  assert.throws(() => endsAfterDays(0, now), ViewAsError);
});

test('a link is a bearer shr_ plus 32 random bytes in base64url, and the keep names only its BLAKE3 digest', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const { bearer, keep } = shareLinkFor({ label: 'Link to Sam', tools, random: () => bytes });
  assert.match(bearer, /^shr_[A-Za-z0-9_-]{43}$/, 'the token has the prefix and 43 base64url characters (32 bytes)');
  const expected = bytesToHex(blake3(new TextEncoder().encode(bearer)));
  const [kept] = keep.input.sharing.people;
  assert.equal(kept.key_blake3, expected, 'the keep holds the digest of the bearer, never the bearer');
  assert.equal(keep.input.sharing.people.every(entry => !JSON.stringify(entry).includes(bearer)), true, 'the bearer is not in the keep');
  assert.match(kept.principal, /^link-[0-9a-f]{16}$/);
  assert.equal(keep.operation, 'sharing.keep');
});

test('the Privacy section sends the share operations and nothing to an old /view-as or look route', () => {
  const [section] = sharingSections({ shares: [{ label: "Sam's read-only tools", ends: { until: '2026-11-22T12:00:00.000Z' } }] });
  const [form, share] = section.rows;
  assert.deepEqual(form.fields.map(field => field.name), ['label', 'days']);
  assert.deepEqual(form.actions[0].send, { resource: '@own-records', operation: 'sharing.keep', with_fields: true });
  assert.deepEqual(form.actions[1].send, { resource: '@own-records', operation: 'sharing.keep', with_fields: true, link: true });
  assert.equal(share.actions[0].send.operation, 'sharing.withdraw');
  assert.deepEqual(share.actions[0].send.input, { label: "Sam's read-only tools" });
  assert.ok(share.actions[0].send.confirm, 'stopping asks first');
  assert.equal(JSON.stringify(section).includes('/view-as'), false, 'no old /view-as route');
  assert.equal(JSON.stringify(section).includes('/work/api/account/looking'), false, 'no old look route');
  assert.equal(sharingSections({})[0].rows.length, 1, 'no shares, only the form');
  assert.equal(viewAsSettings.days.length, 3);
});
