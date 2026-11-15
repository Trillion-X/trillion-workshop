// The platform feature predicate retained from old src/plan-comparison.mjs:66 at b6ae0eb.
// Inputs model policy-source:account.access, which LocalAccount::access_reader reads;
// seller content grants and authentication results are not that platform policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withheldFeature } from './platform-policy-fixture.mjs';
import comparison from '../src/plan-comparison.json' with { type: 'json' };

const workshop = comparison.features.find(row => row.id === 'workshop');
const decisionAccess = workshop.access;
const free = { capabilities: [decisionAccess], limits: { [decisionAccess]: [{ count: 5, per: 'month' }] } };
const paid = { capabilities: [decisionAccess], limits: {} };

test('the platform predicate distinguishes the limited free plan from an unlimited grant', () => {
  assert.deepEqual(withheldFeature(free, '/tools/run', 'POST'), { id: workshop.id, label: workshop.label });
  assert.equal(withheldFeature(paid, '/tools/run', 'POST'), null);
  assert.deepEqual(withheldFeature({ capabilities: [], limits: {} }, '/tools/run', 'POST'), { id: workshop.id, label: workshop.label });
});

test('a seller content grant cannot substitute for the platform account capabilities', () => {
  const sellerOnly = {
    capabilities: [], limits: {},
    granted: [{ access: decisionAccess, by: 'seller:synthetic' }],
    held_access_refs: [decisionAccess],
  };
  assert.deepEqual(withheldFeature(sellerOnly, '/tools/run', 'POST'), { id: workshop.id, label: workshop.label });
  assert.equal(withheldFeature({ ...sellerOnly, ...paid }, '/tools/run', 'POST'), null);
});

test('the entitlement names the operation path and method rather than a generic auth refusal', () => {
  const spaces = comparison.features.find(row => row.id === 'spaces');
  assert.deepEqual(withheldFeature(free, '/spaces', 'POST'), { id: spaces.id, label: spaces.label });
  assert.equal(withheldFeature(free, '/spaces', 'GET'), null);
  assert.equal(withheldFeature(paid, '/spaces', 'POST'), null);
  assert.equal(withheldFeature(free, '/account', 'GET'), null);
});

test('auth and reach refusal fields do not become a platform-plan refusal', () => {
  for (const refusal of [
    { authenticated: false },
    { reach: { private: false, spaces: [] } },
    { accepted: false, code: 'current_workspace_rights_refused' },
  ]) {
    // Null answers only the plan question; the account authority still owns
    // authentication/reach admission and may refuse the operation separately.
    assert.equal(withheldFeature({ ...paid, ...refusal }, '/tools/run', 'POST'), null);
  }
});

test('an unavailable account access read cannot be replaced by a plan-denial result', () => {
  assert.throws(() => withheldFeature(null, '/tools/run', 'POST'), TypeError);
});
