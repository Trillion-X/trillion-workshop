// Capture exclusion categories with cursor diffs (tools/record-the-screen/do-work/capture-exclusion.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiff, categoriesOn, domainsIn, domainsOf, exclusionSettings, excluded } from '../do-work/capture-exclusion.mjs';

const settings = exclusionSettings();
const empty = { cursor: 0, added: {}, removed: [] };

test('the person choice beats the default, subdomains count, look-alikes do not', () => {
  assert.deepEqual(categoriesOn(settings, {}), ['adult-content', 'banking-finance']);
  assert.deepEqual(categoriesOn(settings, { 'banking-finance': false, social: true }), ['adult-content', 'social']);
  assert.equal(excluded(settings, empty, {}, 'https://secure.chase.com/login'), 'banking-finance');
  assert.equal(excluded(settings, empty, {}, 'chase.com'), 'banking-finance');
  assert.equal(excluded(settings, empty, {}, 'https://notchase.com'), null);
  assert.equal(excluded(settings, empty, {}, 'https://www.reddit.com/r/x'), null, 'social is not on by default');
  assert.equal(excluded(settings, empty, { social: true }, 'https://www.reddit.com/r/x'), 'social');
  assert.equal(excluded(settings, empty, {}, '::::'), null);
  assert.ok(domainsOf(settings, empty, {}).includes('paypal.com'));
});

test('a diff must start at the cursor, adds new domains, tombstones outlive the seed, and a re-added domain returns', () => {
  const one = applyDiff(settings, empty, { from: 0, to: 5, add: [{ domain: 'New-Bank.example', category: 'banking-finance' }], remove: ['paypal.com'] });
  assert.equal(one.cursor, 5);
  assert.equal(excluded(settings, one, {}, 'https://login.new-bank.example'), 'banking-finance');
  assert.equal(excluded(settings, one, {}, 'https://paypal.com'), null, 'the tombstone beats the seed');
  assert.throws(() => applyDiff(settings, one, { from: 0, to: 6 }), { status: 409 });
  assert.throws(() => applyDiff(settings, one, { from: 5, to: 6, add: [{ domain: 'a.example', category: 'nope' }] }), /no category nope/);
  const back = applyDiff(settings, one, { from: 5, to: 9, add: [{ domain: 'paypal.com', category: 'banking-finance' }] });
  assert.equal(excluded(settings, back, {}, 'https://paypal.com'), 'banking-finance');
  assert.equal(domainsIn(settings, back, 'banking-finance').filter(d => d === 'paypal.com').length, 1);
});
