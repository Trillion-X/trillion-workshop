// Which offers a buyer may see is a blind predicate over the seller's rule rows and what the buyer already holds.
// A refund shrinks what is held, so every decision reverses with no code. Offers with no rule are never touched.
import { describe, expect, it } from './expect.mjs';
import { applyOfferEligibility, decideOfferEligibility, readOfferEligibilityRules } from '../read-data/offer-eligibility.ts';

const OFFERS = [{ id: 'offer:free-tasting' }, { id: 'offer:loaf' }, { id: 'offer:loaf-club' }, { id: 'offer:workshop' }];

const RULES = {
  records: [
    // the club is offered only to people who already hold a loaf plan
    { kind: 'offer-eligibility-rule', id: 'elig:club', offer_id: 'offer:loaf-club', requires_held: ['access:loaf'] },
    // do not resell the loaf plan to someone who holds it
    { kind: 'offer-eligibility-rule', id: 'elig:owned', offer_id: 'offer:loaf', excludes_held: ['access:loaf'] },
    // malformed rows are dropped, never guessed
    { kind: 'offer-eligibility-rule', id: '', offer_id: 'offer:x' },
    { kind: 'something-else', id: 'not-a-rule', offer_id: 'offer:loaf' },
  ],
};

describe('eligibility rules are data', () => {
  it('reads exactly the well-formed rule rows', () => {
    const rules = readOfferEligibilityRules(RULES);
    expect(rules.map(rule => rule.id)).toEqual(['elig:club', 'elig:owned']);
    expect(rules[0].when_ineligible).toBe('hide');
  });
});

describe('decisions from what the buyer holds', () => {
  it('a new visitor sees the base offers and not the upsell', () => {
    const { offers, decisions } = applyOfferEligibility(OFFERS, [], RULES);
    expect(offers.map(offer => offer.id)).toEqual(['offer:free-tasting', 'offer:loaf', 'offer:workshop']);
    expect(decisions.find(decision => decision.offer_id === 'offer:loaf-club')).toMatchObject({ eligible: false, missing_required: ['access:loaf'] });
  });

  it('a holder sees the upsell and no longer the plan they own', () => {
    const { offers } = applyOfferEligibility(OFFERS, ['access:loaf'], RULES);
    expect(offers.map(offer => offer.id)).toEqual(['offer:free-tasting', 'offer:loaf-club', 'offer:workshop']);
  });

  it('a refund (the held set shrinks) reverses both decisions', () => {
    const before = applyOfferEligibility(OFFERS, ['access:loaf'], RULES).offers.map(offer => offer.id);
    const after = applyOfferEligibility(OFFERS, [], RULES).offers.map(offer => offer.id);
    expect(before).toContain('offer:loaf-club');
    expect(after).not.toContain('offer:loaf-club');
    expect(after).toContain('offer:loaf');
  });

  it('offers without rules are untouched', () => {
    expect(applyOfferEligibility(OFFERS, [], { records: [] }).offers).toEqual(OFFERS);
  });

  it('a rule that says show keeps the offer visible while still reporting the decision', () => {
    const { offers, decisions } = decideOfferEligibility(OFFERS, [], [{ id: 'r', offer_id: 'offer:loaf-club', requires_held: ['access:loaf'], excludes_held: [], when_ineligible: 'show' }]);
    expect(offers.map(offer => offer.id)).toContain('offer:loaf-club');
    expect(decisions[0].eligible).toBe(false);
  });

  it('the same predicate serves a different domain (course prerequisites)', () => {
    const { offers } = decideOfferEligibility([{ id: 'course:intro' }, { id: 'course:advanced' }], ['cert:intro'], [
      { id: 'r1', offer_id: 'course:advanced', requires_held: ['cert:intro'], excludes_held: [], when_ineligible: 'hide' },
      { id: 'r2', offer_id: 'course:intro', requires_held: [], excludes_held: ['cert:intro'], when_ineligible: 'hide' },
    ]);
    expect(offers.map(offer => offer.id)).toEqual(['course:advanced']);
  });
});
