// tools/funnels-and-offers/test/funnel-definition.test.mjs
// The funnel-definition contract: reading the record, the generic $ref identity split, the blind join to the records the
// refs name, the deletion test (a hiring pipeline resolves through the same code) and the rule that a stage shows the
// price option it NAMES, never one picked by position.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveVariantMapFromDecisions, readFunnelDefinition, refIdentity, resolveFunnelDefinition } from '../read-data/funnel-definition.mjs';

const salesFunnel = {
  kind: 'funnel-definition',
  id: 'funnel:offer-ladder',
  title: 'Offer ladder',
  stages: [
    {
      stage_address: 'stage:ladder:visit',
      workflow_node_ref: { $ref: 'workflow-definition:ladder#visit' },
      outcome_edges: [{ outcome_token: 'clicked', to_stage: 'stage:ladder:offer' }],
      variant_surface_ref: { $ref: 'choose-per-observer:front-price' },
      offer_price_ref: { $ref: 'commercial-offer:front' },
      metric_selectors: [
        { measure_ref: 'progression-evaluator:visit-entered', role: 'entered' },
        { measure_ref: 'progression-evaluator:visit-converted', role: 'converted' },
      ],
    },
    {
      stage_address: 'stage:ladder:offer',
      workflow_node_ref: { $ref: 'workflow-definition:ladder#offer' },
      offer_price_ref: { $ref: 'commercial-offer:front' },
      metric_selectors: [
        { measure_ref: 'progression-evaluator:offer-entered', role: 'entered' },
        { measure_ref: 'progression-evaluator:offer-converted', role: 'converted' },
      ],
    },
  ],
};

const owners = {
  workflowNodes: [{ id: 'visit', label: 'Visited the page' }, { id: 'offer', label: 'Saw the offer' }],
  variantSurfaces: [{ id: 'front-price', candidates: [{ candidate_id: 'a', label: '$47', amount_cents: 4700 }, { candidate_id: 'b', label: '$67', amount_cents: 6700 }] }],
  offers: [{ id: 'front', price_options: [{ id: 'p1', amount_cents: 4700, currency: 'usd' }] }],
  measures: [
    { id: 'visit-entered', value: 1000 },
    { id: 'visit-converted', value: 250, provenance: 'measure:visit-converted', confidence: 0.9 },
    { id: 'offer-entered', value: 250 },
    { id: 'offer-converted', value: 40 },
  ],
  liveVariantBySurface: { 'front-price': 'b' },
};

test('refIdentity takes the tail id after the owner-kind prefix and any #sub, with no domain knowledge', () => {
  assert.deepEqual(refIdentity({ $ref: 'workflow-definition:ladder#visit' }), { id: 'ladder', sub: 'visit' });
  assert.deepEqual(refIdentity({ $ref: 'commercial-offer:front' }), { id: 'front' });
  assert.deepEqual(refIdentity({ $ref: 'bare-id' }), { id: 'bare-id' });
  assert.equal(refIdentity(undefined), null);
});

test('readFunnelDefinition keeps a valid record and rejects non-funnel and id-less ones', () => {
  const def = readFunnelDefinition(salesFunnel);
  assert.equal(def.id, 'funnel:offer-ladder');
  assert.equal(def.stages.length, 2);
  assert.deepEqual(def.stages[0].outcome_edges, [{ outcome_token: 'clicked', to_stage: 'stage:ladder:offer' }]);
  assert.equal(readFunnelDefinition({ kind: 'not-a-funnel', id: 'x' }), null);
  assert.equal(readFunnelDefinition({ kind: 'funnel-definition' }), null);
  assert.equal(readFunnelDefinition(null), null);
  assert.equal(readFunnelDefinition({ kind: 'funnel-definition', id: 'f', stages: [{ title: 'no address' }, 'x'] }).stages.length, 0);
});

test('joins each stage to the records its refs name', () => {
  const funnel = resolveFunnelDefinition([salesFunnel], owners);
  assert.equal(funnel.title, 'Offer ladder');
  const [visit, offer] = funnel.stages;
  assert.equal(visit.title, 'Visited the page');
  assert.equal(visit.entered, 1000);
  assert.equal(visit.converted, 250);
  assert.equal(visit.conversion_rate, 25);
  const converted = visit.measures.find(measure => measure.role === 'converted');
  assert.equal(converted.provenance, 'measure:visit-converted');
  assert.equal(converted.confidence, 0.9);
  assert.deepEqual(visit.variants.map(variant => variant.candidate_id), ['a', 'b']);
  assert.equal(visit.variants.find(variant => variant.candidate_id === 'b').live, true);
  assert.equal(visit.variants.find(variant => variant.candidate_id === 'a').live, false);
  assert.equal(visit.offer_amount_cents, 4700);
  assert.equal(offer.entered, 250);
  assert.equal(offer.conversion_rate, 16);
});

test('a stage with its own title keeps it over the node label; a missing owner record leaves the stage present and unresolved', () => {
  const titled = { ...salesFunnel, stages: [{ ...salesFunnel.stages[0], title: 'Front door' }] };
  assert.equal(resolveFunnelDefinition([titled], owners).stages[0].title, 'Front door');
  const funnel = resolveFunnelDefinition([salesFunnel], {});
  assert.equal(funnel.stages.length, 2);
  assert.equal(funnel.stages[0].title, 'stage:ladder:visit');
  assert.equal(funnel.stages[0].entered, 0);
  assert.equal(funnel.stages[0].conversion_rate, 0);
  assert.deepEqual(funnel.stages[0].variants, []);
});

test('a candidate that points at an offer takes its price from that offer, by the option it names', () => {
  const surface = { id: 'front-price', candidates: [{ candidate_id: 'm', material_ref: 'commercial-offer:front', price_option_ref: 'p:monthly' }, { candidate_id: 'n', offer_ref: 'commercial-offer:front' }] };
  const offer = { id: 'front', price_options: [{ id: 'p:trial', amount_cents: 0 }, { id: 'p:monthly', amount_cents: 25000, currency: 'usd' }] };
  const stage = resolveFunnelDefinition([salesFunnel], { variantSurfaces: [surface], offers: [offer] }).stages[0];
  assert.deepEqual(stage.variants, [{ candidate_id: 'm', amount_cents: 25000, currency: 'usd' }, { candidate_id: 'n' }]);
});

test('an empty or unknown funnel id gives null', () => {
  assert.equal(resolveFunnelDefinition([], owners), null);
  assert.equal(resolveFunnelDefinition([salesFunnel], owners, 'funnel:does-not-exist'), null);
  assert.equal(resolveFunnelDefinition([salesFunnel], owners, 'ladder').id, 'funnel:offer-ladder');
});

test('the deletion test: a hiring pipeline resolves through the same code', () => {
  const hiring = {
    kind: 'funnel-definition', id: 'funnel:hiring', title: 'Recruiting pipeline',
    stages: [
      { stage_address: 'stage:hire:applied', workflow_node_ref: { $ref: 'workflow-definition:hiring#applied' }, metric_selectors: [{ measure_ref: 'm:applied-entered', role: 'entered' }, { measure_ref: 'm:applied-advanced', role: 'converted' }] },
      { stage_address: 'stage:hire:offer', workflow_node_ref: { $ref: 'workflow-definition:hiring#offer' }, metric_selectors: [{ measure_ref: 'm:offer-entered', role: 'entered' }, { measure_ref: 'm:offer-accepted', role: 'converted' }] },
    ],
  };
  const funnel = resolveFunnelDefinition([hiring], {
    workflowNodes: [{ id: 'applied', label: 'Applied' }, { id: 'offer', title: 'Offer extended' }],
    measures: [{ id: 'applied-entered', value: 500 }, { id: 'applied-advanced', value: 120 }, { id: 'offer-entered', value: 30 }, { id: 'offer-accepted', value: 24 }],
  });
  assert.equal(funnel.title, 'Recruiting pipeline');
  assert.equal(funnel.stages[0].title, 'Applied');
  assert.equal(funnel.stages[0].conversion_rate, 24);
  assert.equal(funnel.stages[1].title, 'Offer extended');
  assert.equal(funnel.stages[1].conversion_rate, 80);
});

// Which price option a stage shows is NAMED, never inferred from position: taking the first option with an amount
// (including zero) is how a $0 trial was shown for a paid product.
const paidOfferWithTrialFirst = { id: 'front', price_options: [{ id: 'p:trial', amount_cents: 0, currency: 'usd' }, { id: 'p:monthly', amount_cents: 25000, currency: 'usd' }] };
const stageNaming = over => ({ kind: 'funnel-definition', id: 'funnel:money', stages: [{ stage_address: 'stage:one', offer_price_ref: { $ref: 'commercial-offer:front' }, ...over }] });
const amountOf = (raw, offer) => resolveFunnelDefinition([raw], { offers: [offer] }).stages[0].offer_amount_cents;

test('a stage shows the NAMED option, not the $0 row that happens to be first', () => {
  assert.equal(amountOf(stageNaming({ price_option_ref: 'p:monthly' }), paidOfferWithTrialFirst), 25000);
});

test('with several options and none named, no price is shown rather than a guess', () => {
  assert.equal(amountOf(stageNaming({}), paidOfferWithTrialFirst), undefined);
});

test('a sole option needs no name', () => {
  assert.equal(amountOf(stageNaming({}), { id: 'front', price_options: [{ id: 'p1', amount_cents: 4700, currency: 'usd' }] }), 4700);
});

test('a named option that is not on the offer shows nothing, and does not fall back to position', () => {
  assert.equal(amountOf(stageNaming({ price_option_ref: 'p:deleted' }), paidOfferWithTrialFirst), undefined);
});

test('an offer with a flat amount and no options is still read', () => {
  assert.equal(amountOf(stageNaming({}), { id: 'front', amount_cents: 900 }), 900);
  assert.equal(amountOf(stageNaming({}), { id: 'front', offer: { amount_cents: 700 } }), 700);
});

test('the reader keeps the named option id', () => {
  assert.equal(readFunnelDefinition(stageNaming({ price_option_ref: 'p:monthly' })).stages[0].price_option_ref, 'p:monthly');
});

test('decisions fold into the live version of each surface and junk rows are ignored', () => {
  assert.deepEqual(liveVariantMapFromDecisions([{ surface_address: 's1', winner_id: 'b' }, { surface_address: 5, winner_id: 'x' }, null, { surface_address: 's2' }]), { s1: 'b' });
});
