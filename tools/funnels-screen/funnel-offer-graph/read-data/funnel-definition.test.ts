// packages/funnel-offer-graph/read-data/funnel-definition.test.ts
//
// Covers the stage_address DATA contract: reading a funnel-definition record,
// the generic $ref identity split, the blind ref-join against owner records
// (workflow nodes, choose-per-observer surfaces, checkout offers, measures,
// visual-database detail views), and the tornado layout projection. The DELETION
// TEST proves the resolver is a true primitive: a completely different domain
// (a hiring pipeline) resolves through the same code with ZERO changes.

import { describe, expect, it } from 'vitest';
import {
  readFunnelDefinition,
  refIdentity,
  resolveFunnelDefinition,
  type FunnelOwnerRecords,
} from './funnel-definition';
import { layoutTornado, TORNADO_MAX_WIDTH, TORNADO_MIN_WIDTH } from './stage-projection';

// A self-describing sales offer-ladder funnel (no production ids — pure DATA).
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
      detail_projection_ref: { $ref: 'visual-database.view-descriptor:visit-detail' },
      row_actions: [{ action_ref: 'action:message-visitor', label_ref: 'label:message' }],
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

const owners: FunnelOwnerRecords = {
  workflowNodes: [
    { id: 'visit', label: 'Visited the page' },
    { id: 'offer', label: 'Saw the offer' },
  ],
  variantSurfaces: [
    {
      id: 'front-price',
      candidates: [
        { candidate_id: 'a', label: '$47', amount_cents: 4700 },
        { candidate_id: 'b', label: '$67', amount_cents: 6700 },
      ],
    },
  ],
  offers: [
    { id: 'front', price_options: [{ id: 'p1', amount_cents: 4700, currency: 'usd' }] },
  ],
  measures: [
    { id: 'visit-entered', value: 1000 },
    { id: 'visit-converted', value: 250, provenance: 'measure:visit-converted', confidence: 0.9 },
    { id: 'offer-entered', value: 250 },
    { id: 'offer-converted', value: 40 },
  ],
  detailViews: [{ kind: 'visual-database.view-descriptor', id: 'visit-detail' }],
  liveVariantBySurface: { 'front-price': 'b' },
};

describe('refIdentity (generic $ref pointer split — no domain knowledge)', () => {
  it('takes the tail id after the owner-kind prefix and any #sub', () => {
    expect(refIdentity({ $ref: 'workflow-definition:ladder#visit' })).toEqual({ id: 'ladder', sub: 'visit' });
    expect(refIdentity({ $ref: 'commercial-offer:front' })).toEqual({ id: 'front' });
    expect(refIdentity({ $ref: 'bare-id' })).toEqual({ id: 'bare-id' });
    expect(refIdentity(undefined)).toBeNull();
  });
});

describe('readFunnelDefinition', () => {
  it('normalizes a valid record and rejects non-funnel / id-less records', () => {
    const def = readFunnelDefinition(salesFunnel)!;
    expect(def.id).toBe('funnel:offer-ladder');
    expect(def.stages).toHaveLength(2);
    expect(def.stages[0].outcome_edges).toEqual([{ outcome_token: 'clicked', to_stage: 'stage:ladder:offer' }]);
    expect(readFunnelDefinition({ kind: 'not-a-funnel', id: 'x' })).toBeNull();
    expect(readFunnelDefinition({ kind: 'funnel-definition' })).toBeNull();
    expect(readFunnelDefinition(null)).toBeNull();
  });
});

describe('resolveFunnelDefinition (blind ref-join)', () => {
  it('joins each stage to its seven concerns by $ref identity', () => {
    const funnel = resolveFunnelDefinition([salesFunnel], owners)!;
    expect(funnel.title).toBe('Offer ladder');
    const [visit, offer] = funnel.stages;

    // title READ from the workflow node (SSOT — not stored twice)
    expect(visit.title).toBe('Visited the page');
    // measures resolved + conversion computed from entered/converted
    expect(visit.entered).toBe(1000);
    expect(visit.converted).toBe(250);
    expect(visit.conversion_rate).toBe(25);
    // provenance + confidence carried through from the owner measure
    expect(visit.measures.find((m) => m.role === 'converted')?.provenance).toBe('measure:visit-converted');
    expect(visit.measures.find((m) => m.role === 'converted')?.confidence).toBe(0.9);
    // variants resolved; the decided candidate is flagged live
    expect(visit.variants.map((v) => v.candidate_id)).toEqual(['a', 'b']);
    expect(visit.variants.find((v) => v.candidate_id === 'b')?.live).toBe(true);
    expect(visit.variants.find((v) => v.candidate_id === 'a')?.live).toBe(false);
    // offer + detail projection + actions resolved
    expect(visit.offer_amount_cents).toBe(4700);
    expect(visit.detail_projection_id).toBe('visit-detail');
    expect(visit.row_actions[0].action_ref).toBe('action:message-visitor');

    expect(offer.entered).toBe(250);
    expect(offer.conversion_rate).toBe(16); // 40/250
  });

  it('fail-soft: missing owner records yield present-but-unresolved stages, never a throw', () => {
    const funnel = resolveFunnelDefinition([salesFunnel], {})!;
    expect(funnel.stages).toHaveLength(2);
    // no workflow node → title falls back to the stage address
    expect(funnel.stages[0].title).toBe('stage:ladder:visit');
    expect(funnel.stages[0].entered).toBe(0);
    expect(funnel.stages[0].conversion_rate).toBe(0);
    expect(funnel.stages[0].variants).toEqual([]);
  });

  it('returns null for an empty / unknown funnel id (fail-soft)', () => {
    expect(resolveFunnelDefinition([], owners)).toBeNull();
    expect(resolveFunnelDefinition([salesFunnel], owners, 'funnel:does-not-exist')).toBeNull();
  });

  // ── THE DELETION TEST ──────────────────────────────────────────────────
  // Delete the sales funnel entirely; drop in a completely different domain
  // (a hiring pipeline) as pure DATA. The SAME resolver produces the funnel
  // with ZERO code change — proving stage_address is a generative primitive,
  // not a sales-funnel special case (CLAUDE.md examples-are-configs mandate).
  it('resolves a totally different domain (hiring pipeline) with zero code change', () => {
    const hiringFunnel = {
      kind: 'funnel-definition',
      id: 'funnel:hiring',
      title: 'Recruiting pipeline',
      stages: [
        {
          stage_address: 'stage:hire:applied',
          workflow_node_ref: { $ref: 'workflow-definition:hiring#applied' },
          metric_selectors: [
            { measure_ref: 'progression-evaluator:applied-entered', role: 'entered' },
            { measure_ref: 'progression-evaluator:applied-advanced', role: 'converted' },
          ],
        },
        {
          stage_address: 'stage:hire:offer',
          workflow_node_ref: { $ref: 'workflow-definition:hiring#offer' },
          metric_selectors: [
            { measure_ref: 'progression-evaluator:offer-entered', role: 'entered' },
            { measure_ref: 'progression-evaluator:offer-accepted', role: 'converted' },
          ],
        },
      ],
    };
    const hiringOwners: FunnelOwnerRecords = {
      workflowNodes: [
        { id: 'applied', label: 'Applied' },
        { id: 'offer', title: 'Offer extended' },
      ],
      measures: [
        { id: 'applied-entered', value: 500 },
        { id: 'applied-advanced', value: 120 },
        { id: 'offer-entered', value: 30 },
        { id: 'offer-accepted', value: 24 },
      ],
    };
    const funnel = resolveFunnelDefinition([hiringFunnel], hiringOwners)!;
    expect(funnel.title).toBe('Recruiting pipeline');
    expect(funnel.stages[0].title).toBe('Applied');
    expect(funnel.stages[0].conversion_rate).toBe(24); // 120/500
    expect(funnel.stages[1].title).toBe('Offer extended');
    expect(funnel.stages[1].conversion_rate).toBe(80); // 24/30
  });
});

describe('layoutTornado (narrowing funnel silhouette as graph-canvas frames)', () => {
  const stages = [
    { stage_address: 's1', entered: 1000, converted: 250, outcome_edges: [{ outcome_token: 'clicked', to_stage: 's2' }] },
    { stage_address: 's2', entered: 250, converted: 40, outcome_edges: [{ outcome_token: 'bought', to_stage: 's3' }] },
    { stage_address: 's3', entered: 40, converted: 40 },
  ];

  it('scales bar width by entered volume and centers each bar so the shape narrows', () => {
    const { frames, maxEntered } = layoutTornado(stages);
    expect(maxEntered).toBe(1000);
    const [f1, f2, f3] = frames;
    // widest at the top (most entered), narrowing down
    expect(f1.width).toBe(TORNADO_MAX_WIDTH);
    expect(f1.width).toBeGreaterThan(f2.width);
    expect(f2.width).toBeGreaterThan(f3.width);
    expect(f3.width).toBeGreaterThanOrEqual(TORNADO_MIN_WIDTH);
    // centered on a common axis
    const center = (f: typeof f1) => f.x + f.width / 2;
    expect(center(f1)).toBeCloseTo(center(f2), 0);
    expect(center(f2)).toBeCloseTo(center(f3), 0);
    // stacked top → bottom
    expect(f2.y).toBeGreaterThan(f1.y);
    expect(f3.y).toBeGreaterThan(f2.y);
  });

  it('draws edges from outcome_edges, and terminal targets draw no edge', () => {
    const { edges } = layoutTornado(stages);
    expect(edges.map((e) => e.edge_id)).toEqual(['s1->s2:clicked', 's2->s3:bought']);
  });

  it('falls back to sequential edges when a stage has no outcome_edges', () => {
    const seq = [
      { stage_address: 'a', entered: 10, converted: 5 },
      { stage_address: 'b', entered: 5, converted: 2 },
    ];
    const { edges } = layoutTornado(seq);
    expect(edges.map((e) => e.edge_id)).toEqual(['a->b:next']);
  });

  it('un-instrumented funnel (all-zero measures) renders uniform full-width steps', () => {
    const zero = [
      { stage_address: 'a', entered: 0, converted: 0 },
      { stage_address: 'b', entered: 0, converted: 0 },
    ];
    const { frames } = layoutTornado(zero);
    expect(frames.every((f) => f.width === TORNADO_MAX_WIDTH)).toBe(true);
  });
});

// MONEY-SAFETY: which price option a stage shows is NAMED, never inferred from
// position. `CommercialPriceOption` has no `sort_order` while `CheckoutOffer` has
// one and is sorted by it, and `readPriceOptions` drops label-less options and
// assigns `price:${index}` when an id is absent, so array position is a value
// nobody authored. Taking the first option with a finite amount, INCLUDING zero,
// is the expression that rendered a green "Create free access" CTA on a paid
// product in `checkout/show/CheckoutFlow.tsx:592-598`. This was the same
// expression in a third package, under a docstring calling it generic.
describe('a stage shows the price option it names (money-safety)', () => {
  const paidOfferWithTrialFirst = {
    id: 'front',
    price_options: [
      { id: 'p:trial', amount_cents: 0, currency: 'usd' },
      { id: 'p:monthly', amount_cents: 25000, currency: 'usd' },
    ],
  };
  const stageNaming = (over: Record<string, unknown>) => ({
    kind: 'funnel-definition',
    id: 'funnel:money',
    stages: [{ stage_address: 'stage:one', offer_price_ref: { $ref: 'commercial-offer:front' }, ...over }],
  });
  // `offer_amount_cents`, not `amount_cents`. The stage carries the offer's amount
  // under its own name and `amount_cents` belongs to a variant row, so reading the
  // wrong one made two of these assertions pass by returning undefined where
  // undefined was expected. A test that passes because it read a field nobody has
  // is a verifier that cannot fail.
  const amountOf = (raw: unknown, offer: unknown) => (
    resolveFunnelDefinition([raw], { offers: [offer] } as FunnelOwnerRecords)!.stages[0].offer_amount_cents
  );

  it('shows the NAMED option, not the $0 row that happens to be first', () => {
    expect(amountOf(stageNaming({ price_option_ref: 'p:monthly' }), paidOfferWithTrialFirst)).toBe(25000);
  });

  it('shows nothing rather than guessing when several options exist and none is named', () => {
    // The other direction, and the one that used to silently return 0. An absent
    // amount is honest: the callers spread `amount_cents` conditionally, so the row
    // carries no price instead of carrying a wrong one.
    expect(amountOf(stageNaming({}), paidOfferWithTrialFirst)).toBeUndefined();
  });

  it('needs no name when the offer has exactly one option, because nothing is being chosen', () => {
    const sole = { id: 'front', price_options: [{ id: 'p1', amount_cents: 4700, currency: 'usd' }] };
    expect(amountOf(stageNaming({}), sole)).toBe(4700);
  });

  it('does not invent a price when the named option is not on the offer', () => {
    // A stale or edited id must not fall back to position, which is how a named
    // reference silently becomes a positional one again.
    expect(amountOf(stageNaming({ price_option_ref: 'p:deleted' }), paidOfferWithTrialFirst)).toBeUndefined();
  });

  it('still reads an offer that carries a flat amount and no options at all', () => {
    expect(amountOf(stageNaming({}), { id: 'front', amount_cents: 900 })).toBe(900);
  });

  it('keeps the named id through the reader, which drops any field it does not name', () => {
    const definition = readFunnelDefinition(stageNaming({ price_option_ref: 'p:monthly' }));
    expect(definition!.stages[0].price_option_ref).toBe('p:monthly');
  });
});
