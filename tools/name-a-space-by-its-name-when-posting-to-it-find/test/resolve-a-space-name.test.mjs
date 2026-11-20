// The old src/space-names.mjs assertions (test/space-brief.test.mjs at 289270b644, the name block), on made-up spaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSpaceId, spaceNamed } from '../do-work/resolve-a-space-name.mjs';

// The wording row, as src/space-settings.json `named` holds it at 289270b644 (lines 29-35).
const words = {
  none: 'None of your spaces is named "{name}". Your spaces: {spaces}.',
  several: 'More than one of your spaces is named "{name}"; use its space_id. They are: {spaces}.',
  no_spaces: 'none yet',
  one_space: '"{title}" ({space_id})',
};
const popcorn = { id: 'membership_aaaa', title: 'Popcorn company' };
const tasting = { id: 'membership_bbbb', title: 'Popcorn tasting club' };
const chess = { id: 'membership_cccc', title: 'Chess' };
// Newest first, as the member store lists them.
const spaces = [tasting, popcorn, chess];

test('a space id is told from a name by its shape', () => {
  assert.equal(looksLikeSpaceId('membership_9f2c'), true);
  assert.equal(looksLikeSpaceId('Popcorn company'), false);
  assert.equal(looksLikeSpaceId('Membership_9f2c'), false);
  assert.equal(looksLikeSpaceId(undefined), false);
});

test('a name matches the one space whose title is it, in any case', () => {
  assert.deepEqual(spaceNamed({ name: 'popcorn COMPANY', spaces, words }), { space_id: popcorn.id });
});

test('a name matches the one space whose title holds it', () => {
  assert.deepEqual(spaceNamed({ name: 'company', spaces, words }), { space_id: popcorn.id });
});

test('a name fitting several spaces is refused with each space and its id', () => {
  assert.throws(() => spaceNamed({ name: 'popcorn', spaces, words }),
    /More than one of your spaces is named "popcorn"; use its space_id\. They are: .*"Popcorn company" \(membership_aaaa\)/);
});

test('a name fitting no space is refused with every space', () => {
  assert.throws(() => spaceNamed({ name: 'Golf', spaces, words }),
    /None of your spaces is named "Golf"\. Your spaces: "Popcorn tasting club" \(membership_bbbb\), "Popcorn company" \(membership_aaaa\), "Chess" \(membership_cccc\)\./);
});

test('a space outside the reach is never matched', () => {
  assert.throws(() => spaceNamed({ name: 'Popcorn company', spaces, within: [], words }), /None of your spaces/);
  assert.deepEqual(spaceNamed({ name: 'Popcorn company', spaces, within: [popcorn.id], words }), { space_id: popcorn.id });
});

test('no spaces at all says so in the wording row', () => {
  assert.throws(() => spaceNamed({ name: 'Chess', spaces: [], words }), /None of your spaces is named "Chess"\. Your spaces: none yet\./);
});
