// T5 resolver unit tests: graph resolution, A/B winner price provenance,
// BFS order, the state-machine advance, cursor fallback, and CTA ordering —
// all with zero hardcoded production ids (fixtures are self-describing DATA).
import { describe, expect, it } from 'vitest';
import {
  advanceFunnel,
  funnelStepAtCursor,
  readFunnelNode,
  resolveCtaLinks,
  resolveExperimentWinnerAmount,
  resolveFunnelFlow,
} from './resolve-funnel-flow';

const node = (id: string, amount: number, transitions: Array<{ on: string; to: string }>, extra: Record<string, unknown> = {}) => ({
  id, entry: extra.entry === true, offer: { amount_cents: amount, name: `Offer ${id}` }, transitions, ...extra,
});

const graphs = [{ id: 'graph:ladder', entry_node: 'front' }];
const nodes = [
  node('front', 4700, [{ on: 'purchase', to: 'bump' }, { on: 'decline', to: 'exit' }], { entry: true }),
  node('bump', 9700, [{ on: 'purchase', to: 'core' }, { on: 'decline', to: 'core' }]),
  node('core', 49700, [{ on: 'purchase', to: 'thank-you' }, { on: 'decline', to: 'thank-you' }]),
];

describe('readFunnelNode', () => {
  it('normalizes a valid record and rejects malformed ones', () => {
    expect(readFunnelNode(nodes[0])?.offer.amount_cents).toBe(4700);
    expect(readFunnelNode({ id: 'x' })).toBeNull();
    expect(readFunnelNode(null)).toBeNull();
    expect(readFunnelNode({ id: 'x', offer: { amount_cents: 'NaN', name: 'bad' } })).toBeNull();
  });
});

describe('resolveFunnelFlow', () => {
  it('resolves entry, steps, and BFS order from DATA alone', () => {
    const flow = resolveFunnelFlow(graphs, nodes)!;
    expect(flow.graph_id).toBe('graph:ladder');
    expect(flow.entry.id).toBe('front');
    expect(flow.order).toEqual(['front', 'bump', 'core']);
    expect(flow.entry.price_source).toBe('node-offer');
    expect(flow.entry.display_amount_cents).toBe(4700);
  });

  it('entry price comes from a graduated experiment winner with provenance', () => {
    const experiments = [{ id: 'exp:front-price', state: 'graduated', node_ref: 'node::front', result: { winner: '37' } }];
    const flow = resolveFunnelFlow(graphs, nodes, experiments)!;
    expect(flow.entry.display_amount_cents).toBe(3700);
    expect(flow.entry.price_source).toBe('experiment-winner');
    expect(flow.entry.price_source_ref).toBe('exp:front-price');
    // non-entry nodes keep their own offer price
    expect(flow.steps.bump.display_amount_cents).toBe(9700);
  });

  it('a running (non-settled) experiment never decides a live price', () => {
    const experiments = [{ id: 'exp:running', state: 'running', node_ref: 'front', result: { winner: '1' } }];
    const flow = resolveFunnelFlow(graphs, nodes, experiments)!;
    expect(flow.entry.price_source).toBe('node-offer');
  });

  it('winner resolves through the offer-experiment idea-ref chain + variant record', () => {
    const offerExperiments = [{ node_ref: 'node::front', outcome_links: { outcome: 'idea-ref:idea::front-price' } }];
    const experiments = [{ id: 'exp:linked', state: 'settled', idea_ref: 'idea::front-price', result: { winner: 'v-a' } }];
    const variants = [{ variant_key: 'v-a', amount_cents: 2900 }];
    const win = resolveExperimentWinnerAmount('front', experiments, variants, offerExperiments);
    expect(win).toEqual({ amount_cents: 2900, ref: 'exp:linked' });
  });

  it('fail-soft: no graph or no entry node yields null, never a throw', () => {
    expect(resolveFunnelFlow([], nodes)).toBeNull();
    expect(resolveFunnelFlow(graphs, [])).toBeNull();
    expect(resolveFunnelFlow([{ id: 'g' }], [node('a', 100, [])])).toBeNull();
  });
});

describe('advanceFunnel + funnelStepAtCursor (state machine)', () => {
  const flow = resolveFunnelFlow(graphs, nodes)!;

  it('advances along the outcome transition', () => {
    const a = advanceFunnel(flow, 'front', 'purchase');
    expect(a.next?.id).toBe('bump');
    expect(a.terminal).toBe(false);
  });

  it('a target absent from steps is terminal (thank-you/exit tokens)', () => {
    const a = advanceFunnel(flow, 'core', 'purchase');
    expect(a).toEqual({ next: null, target: 'thank-you', terminal: true });
    const d = advanceFunnel(flow, 'front', 'decline');
    expect(d.target).toBe('exit');
    expect(d.terminal).toBe(true);
  });

  it('unknown node or outcome fails soft', () => {
    expect(advanceFunnel(flow, 'nope', 'purchase').terminal).toBe(true);
    expect(advanceFunnel(flow, 'front', 'made-up-outcome').terminal).toBe(true);
  });

  it('cursor fallback: missing/unknown cursor starts at entry', () => {
    expect(funnelStepAtCursor(flow, undefined).id).toBe('front');
    expect(funnelStepAtCursor(flow, 'ghost').id).toBe('front');
    expect(funnelStepAtCursor(flow, 'bump').id).toBe('bump');
  });
});

describe('resolveCtaLinks', () => {
  it('filters by page, primary first, malformed dropped', () => {
    const records = [
      { page: 'p:home', label: 'Learn more', role: 'secondary', href: '/about' },
      { page: 'p:home', label: 'Buy now', role: 'primary', href: '/buy', attribution_key: 'utm_source=x' },
      { page: 'p:other', label: 'Elsewhere', href: '/x' },
      { page: 'p:home', href: '/broken' },
    ];
    const links = resolveCtaLinks(records, 'p:home');
    expect(links.map((l) => l.label)).toEqual(['Buy now', 'Learn more']);
    expect(links[0].attribution).toBe('utm_source=x');
  });
});
