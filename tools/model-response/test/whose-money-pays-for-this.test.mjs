// A spend ceiling is only a ceiling if the failures go the right way. These
// check the three that decide whether a bill can run away: silence from the
// gate, a reply that cannot be read, and an authority with nothing to reserve.
//
// Ported from bitfield-packages packages/model-response (7e4af0df56) to node:test.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  spendGateAskForModelRequest,
  spendGateApproved,
  spendGateRefusalMessage,
} from '../do-work/whose-money-pays-for-this.ts';

test('gates a request whose spend somebody has claimed', () => {
  const ask = spendGateAskForModelRequest({
    spendAuthorityRef: 'spend-authority:hosted-account',
    estimatedCostCents: 4,
    threadRef: 'thread:ada',
    requestId: 'thread:ada:7',
  });
  assert.deepEqual(ask, {
    operation_ref: 'model-response:thread:ada',
    estimated_cost: 4,
    spend_authority_ref: 'spend-authority:hosted-account',
    idempotency_key: 'model-response:thread:ada:7',
  });
});

test('does not stand between a person and their own provider key', () => {
  for (const nobody of [undefined, null, '', '   ', 42]) {
    assert.equal(spendGateAskForModelRequest({
      spendAuthorityRef: nobody,
      estimatedCostCents: 4,
      requestId: 'r1',
    }), null);
  }
});

test('refuses a claimed spend with nothing to reserve', () => {
  for (const missing of [undefined, null, -1, 1.5, '4']) {
    assert.throws(() => spendGateAskForModelRequest({
      spendAuthorityRef: 'spend-authority:x',
      estimatedCostCents: missing,
      requestId: 'r1',
    }), /reserve nothing and approve everything/i);
  }
});

test('refuses a claimed spend it could not tell apart from another', () => {
  assert.throws(() => spendGateAskForModelRequest({
    spendAuthorityRef: 'spend-authority:x',
    estimatedCostCents: 4,
    requestId: '',
  }), /could not tell two requests apart/i);
});

test('proceeds only on an explicit approval', () => {
  assert.equal(spendGateApproved({ approved: true }), true);
});

test('treats anything else as a denial, including an answer it cannot read', () => {
  for (const notAnApproval of [
    undefined, null, {}, 'approved', { approved: 'true' }, { approved: 1 },
    { approved: false, reason: 'Daily limit reached.' },
  ]) {
    assert.equal(spendGateApproved(notAnApproval), false);
  }
});

test('tells the person in their words, never the ledger’s', () => {
  assert.equal(spendGateRefusalMessage({ reason: 'Daily limit reached.' }), 'Daily limit reached.');
  for (const wordless of [undefined, null, {}, { reason: '' }, { reason: 7 }]) {
    assert.equal(spendGateRefusalMessage(wordless), 'This account has reached its usage limit.');
  }
});
