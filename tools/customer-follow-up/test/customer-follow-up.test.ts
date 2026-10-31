// Carried from bitfield-packages packages/customer-follow-up/__tests__/customer-follow-up.test.ts: the two tests of the
// logic (target progress, the step builder). The tests of the old surface, the old runtime's workflow slot and the old
// boundary json stay behind; the new tests of the tools are in customer-follow-up-tools.test.mjs.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildRecordCustomerStepInput } from '../do-work/record-customer-step.ts';
import { customerFollowUpViews, readCustomerFollowUpState } from '../read-data/read-customer-follow-up.ts';

const now = new Date('2026-06-20T12:00:00.000Z');

function targetOnlyRows() {
  return [
    { payload: { kind: 'customer-product-target', targetId: 'target:provided', productId: 'product:provided', productLabel: 'Product target', targetCount: 100, active: true } },
  ];
}

describe('customer-follow-up', () => {
  it('projects target progress without inventing customers, contacts, purchases, or steps', () => {
    const state = readCustomerFollowUpState(targetOnlyRows());
    const views = customerFollowUpViews(state);

    expect(views.products[0]).toMatchObject({
      customerCount: 0,
      targetCount: 100,
      remainingCount: 100,
      percent: 0,
    });
    expect(state.contacts).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(views.selectedContact).toBeUndefined();
  });

  it('builds a customer step only from caller-supplied contact, product, evidence, and owner refs', () => {
    const input = buildRecordCustomerStepInput({
      stepId: 'customer-step:1',
      contactId: ' contact:provided-by-contact-owner ',
      productId: ' product:provided-by-offer-owner ',
      stepKind: 'feedback',
      actorId: ' actor:1 ',
      outcome: ' Asked for onboarding help ',
      evidenceRefs: [' content-production.run:provided ', 'content-production.run:provided', ' content-distribution.intent:provided '],
      ownerRefs: [' crm:owner ', 'checkout:owner', 'access:owner'],
      now,
    });

    expect(input.step_record).toMatchObject({
      kind: 'customer-step',
      stepId: 'customer-step:1',
      contactId: 'contact:provided-by-contact-owner',
      productId: 'product:provided-by-offer-owner',
      stepKind: 'feedback',
      actorId: 'actor:1',
      outcome: 'Asked for onboarding help',
      evidenceRefs: ['content-production.run:provided', 'content-distribution.intent:provided'],
      ownerRefs: ['crm:owner', 'checkout:owner', 'access:owner'],
      createdAt: now.toISOString(),
    });
  });
});
