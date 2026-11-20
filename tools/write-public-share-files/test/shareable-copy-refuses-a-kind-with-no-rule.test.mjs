// tools/write-public-share-files/test/shareable-copy-refuses-a-kind-with-no-rule.test.mjs
// Fail closed (privacy): a copy of a record kind that has no share_from_private rule is refused, never made with its fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shareableCopy } from '../read-data/shareable-copy.mjs';

const secret = { title: 'Private title', salary: 123456 };

test('a kind with no share_from_private rule is refused and no copy is made', () => {
  assert.throws(() => shareableCopy('no-such-kind', 'x:1', secret), /cannot be shared/);
});

test('a kind is refused when the rules name none for it, even if the default rules name others', () => {
  assert.throws(() => shareableCopy('salary-note', 'x:2', secret, {}, {}), /cannot be shared/);
});
