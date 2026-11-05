import test from 'node:test';
import assert from 'node:assert/strict';
import { contractAccessRefs, contractEntitlementSnapshot, consumeEntitlement, contractRules, entitlementSummary, quantityFor, usageFor } from '../src/contract-entitlements.mjs';
import { makeSalesContracts } from '../../build-and-send-a-sales-contract/from-old-trillion/src/sales-contracts.mjs';

test('contract rules grant a bundled offer and expand its access refs from DATA', () => {
  const contract = {
    rules: [
      { type: 'GrantAccess', resource: 'offer:member', condition: 'commitment_active' },
      { type: 'GrantAccess', resource: 'access:consulting-call', usage_limit: 3, unit: 'call', period: 'contract' },
    ],
  };
  const offers = [{ id: 'offer:member', access_refs: ['access:decision-kept', 'access:spaces'] }];
  assert.deepEqual(contractAccessRefs(contract, offers), ['access:consulting-call', 'access:decision-kept', 'access:spaces']);
  assert.deepEqual(quantityFor(contract, 'access:consulting-call'), { resource: 'access:consulting-call', granted: true, quantity: 3, used: 0, remaining: 3, period: 'contract', unit: 'call' });
});

test('finite call credits consume once and refuse after the contract limit', () => {
  const contract = { grants: [{ access: 'access:call', quantity: 2, unit: 'call' }] };
  const first = consumeEntitlement(contract, 'access:call');
  const second = consumeEntitlement(first.contract, 'access:call');
  assert.equal(usageFor(second.contract, 'access:call'), 2);
  assert.equal(second.remaining, 0);
  assert.throws(() => consumeEntitlement(second.contract, 'access:call'), /0 call left/);
  assert.equal(usageFor(contract, 'access:call'), 0, 'input contract is immutable');
});

test('MeterUsage included call credits become the same finite allowance in access, summary, and checkout data', () => {
  const contract = {
    rules: [{
      type: 'MeterUsage', resource: 'access:coaching-call', metric: 'call', period: 'contract',
      pricing_rules: { included_units: 3 },
    }],
  };

  assert.deepEqual(quantityFor(contract, 'access:coaching-call'), {
    resource: 'access:coaching-call', granted: true, quantity: 3, used: 0, remaining: 3, period: 'contract', unit: 'call',
  });
  assert.deepEqual(entitlementSummary(contract), {
    accesses: ['access:coaching-call'], bundled_offers: [],
    limits: [{ resource: 'access:coaching-call', quantity: 3, unit: 'call', period: 'contract', condition: null, used: 0, remaining: 3 }],
  });
  assert.deepEqual(contractEntitlementSnapshot(contract), {
    grants: ['access:coaching-call'],
    limits: [{ key: 'access:coaching-call', quantity: 3, unit: 'call', per: 'contract' }],
  });

  const lastCredit = consumeEntitlement(consumeEntitlement(consumeEntitlement(contract, 'access:coaching-call').contract, 'access:coaching-call').contract, 'access:coaching-call');
  assert.equal(lastCredit.remaining, 0);
  assert.throws(() => consumeEntitlement(lastCredit.contract, 'access:coaching-call'), /0 call left/);
});

test('sales contract drafts stay drafts when saved and are not marked accepted by link preparation', () => {
  const rows = new Map();
  const contracts = makeSalesContracts({
    store: { list: () => [...rows.values()], put: (id, row) => rows.set(id, row) },
    id: () => 'link-draft',
    now: () => '2026-10-01T00:00:00.000Z',
  });
  const draft = contracts.save({ contract: { name: 'Four coaching calls', rules: [{ type: 'MeterUsage', resource: 'access:coaching-call', pricing_rules: { included_units: 4 } }] } });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.accepted_at, undefined);
  assert.equal(draft.accepted_by, undefined);
});

test('summary returns modular limits and current usage', () => {
  const contract = { entitlements: { limits: [{ key: 'feature:spaces', quantity: 4, unit: 'space' }] }, usage: { 'feature:spaces': 1 } };
  assert.deepEqual(entitlementSummary(contract), {
    accesses: ['feature:spaces'], bundled_offers: [],
    limits: [{ resource: 'feature:spaces', quantity: 4, unit: 'space', period: null, condition: null, used: 1, remaining: 3 }],
  });
  assert.equal(contractRules(contract).length, 1);
});
