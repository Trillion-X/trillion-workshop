// packages/funnel-offer-graph/read-data/stage-projection.test.ts
//
// Covers: BFS layout (columns by depth, cycle tolerance, unreachable nodes),
// generic measure reduction (any group-by field, any amount field, empty
// inputs), and the resolver's terminal/cycle/experiment behavior (T5 spec).

import { describe, expect, it } from 'vitest';
import { layoutStages, reduceStageMeasures, STAGE_NODE_WIDTH } from './stage-projection';
import { advanceFunnel, resolveCtaLinks, resolveFunnelFlow } from './resolve-funnel-flow';

const node = (id: string, transitions: Array<{ on: string; to: string }>, entry = false, cents = 1000) => ({
  kind: 'funnel-node', id, entry, offer: { amount_cents: cents, name: `Offer ${id}` }, transitions,
});
const graph = { kind: 'funnel-graph', id: 'g1', entry_node: 'a' };

function flowABC() {
  return resolveFunnelFlow(
    [graph],
    [
      node('a', [{ on: 'yes', to: 'b' }, { on: 'no', to: 'c' }], true),
      node('b', [{ on: 'yes', to: 'exit' }]),
      node('c', [{ on: 'retry', to: 'a' }]), // cycle back to entry
    ],
  )!;
}

describe('layoutStages', () => {
  it('places columns by BFS depth and draws edges only between real nodes', () => {
    const { frames, edges } = layoutStages(flowABC());
    const byId = Object.fromEntries(frames.map((f) => [f.id, f]));
    expect(byId.a.x).toBe(0);
    expect(byId.b.x).toBeGreaterThanOrEqual(STAGE_NODE_WIDTH);
    expect(byId.c.x).toBe(byId.b.x); // same depth
    // b->exit is terminal (no node) → not drawn; c->a cycle IS drawn.
    expect(edges.map((e) => e.edge_id).sort()).toEqual(['a->b:yes', 'a->c:no', 'c->a:retry']);
  });

  it('appends unreachable nodes in a final column instead of dropping them', () => {
    const flow = resolveFunnelFlow([graph], [node('a', [], true), node('zz', [])])!;
    const { frames } = layoutStages(flow);
    const zz = frames.find((f) => f.id === 'zz')!;
    expect(zz.x).toBeGreaterThan(0);
    expect(frames).toHaveLength(2);
  });
});

describe('reduceStageMeasures (generic: any group-by / amount field)', () => {
  it('counts visits, conversions, revenue and rate per stage', () => {
    const facts = [
      { funnel_node_ref: 'a' },
      { funnel_node_ref: 'a', amount_cents: 4700 },
      { funnel_node_ref: 'node:a:qualified', converted: true },
      { funnel_node_ref: 'b' },
      { other: 'ignored' },
    ];
    const m = reduceStageMeasures(facts, ['a', 'b'], 'funnel_node_ref', 'amount_cents');
    expect(m.a).toEqual({ visits: 3, conversions: 2, conversion_rate: 66.7, revenue_cents: 4700 });
    expect(m.b).toEqual({ visits: 1, conversions: 0, conversion_rate: 0, revenue_cents: 0 });
  });

  it('works with a completely different domain vocabulary (deletion test)', () => {
    // Hiring pipeline: kind:candidate facts, stage field `stage_ref`, salary field.
    const facts = [
      { stage_ref: 'applied' }, { stage_ref: 'applied' },
      { stage_ref: 'offer', salary_cents: 100 },
    ];
    const m = reduceStageMeasures(facts, ['applied', 'screened', 'offer'], 'stage_ref', 'salary_cents');
    expect(m.applied.visits).toBe(2);
    expect(m.offer).toMatchObject({ visits: 1, conversions: 1, revenue_cents: 100 });
    expect(m.screened.visits).toBe(0);
  });

  it('yields zeroed measures for empty inputs', () => {
    const m = reduceStageMeasures([], ['a'], 'x', 'y');
    expect(m.a).toEqual({ visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 });
  });
});

describe('advanceFunnel terminal + cycle cases (T5)', () => {
  it('advances along any DATA outcome token and terminates on unknown targets', () => {
    const flow = flowABC();
    expect(advanceFunnel(flow, 'a', 'yes').next?.id).toBe('b');
    const term = advanceFunnel(flow, 'b', 'yes');
    expect(term).toEqual({ next: null, target: 'exit', terminal: true });
    // cycle: c --retry--> a keeps flowing
    expect(advanceFunnel(flow, 'c', 'retry').next?.id).toBe('a');
    // unknown node / unknown outcome fail-soft
    expect(advanceFunnel(flow, 'nope', 'yes').terminal).toBe(true);
    expect(advanceFunnel(flow, 'a', 'unheard-of-token').terminal).toBe(true);
  });
});

describe('resolveCtaLinks ordering (T5)', () => {
  it('sorts primary first and filters by page', () => {
    const links = resolveCtaLinks(
      [
        { kind: 'cta-link', page: 'p1', label: 'Later', href: '#b', role: 'secondary' },
        { kind: 'cta-link', page: 'p1', label: 'Buy', href: '#a', role: 'primary' },
        { kind: 'cta-link', page: 'p2', label: 'Elsewhere', href: '#c' },
      ],
      'p1',
    );
    expect(links.map((l) => l.label)).toEqual(['Buy', 'Later']);
  });
});

describe('experiment-winner precedence (T5)', () => {
  it('entry node shows the graduated winner price; others keep node-offer', () => {
    const flow = resolveFunnelFlow(
      [graph],
      [node('a', [{ on: 'yes', to: 'b' }], true, 9700), node('b', [])],
      [{ kind: 'experiment', id: 'exp1', state: 'graduated', node_ref: 'node:a', result: { winner: '47' } }],
    )!;
    expect(flow.entry.display_amount_cents).toBe(4700);
    expect(flow.entry.price_source).toBe('experiment-winner');
    expect(flow.steps.b.price_source).toBe('node-offer');
  });
});
