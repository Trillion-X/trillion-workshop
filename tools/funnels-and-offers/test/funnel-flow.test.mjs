// tools/funnels-and-offers/test/funnel-flow.test.mjs
// The package's resolver cases: graph resolution, the price a settled experiment decides and where it came from,
// breadth-first order, the state-machine step, cursor fallback and call-to-action order. Fixtures are a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFunnel, funnelStepAtCursor, readFunnelNode, resolveCtaLinks, resolveExperimentWinnerAmount, resolveFunnelFlow } from '../read-data/funnel-flow.mjs';

const node = (id, amount, transitions, extra = {}) => ({ id, entry: extra.entry === true, offer: { amount_cents: amount, name: `Offer ${id}` }, transitions, ...extra });
const graphs = [{ id: 'graph:ladder', entry_node: 'front' }];
const nodes = [
  node('front', 4700, [{ on: 'purchase', to: 'bump' }, { on: 'decline', to: 'exit' }], { entry: true }),
  node('bump', 9700, [{ on: 'purchase', to: 'core' }, { on: 'decline', to: 'core' }]),
  node('core', 49700, [{ on: 'purchase', to: 'thank-you' }, { on: 'decline', to: 'thank-you' }]),
];

test('readFunnelNode keeps a valid record and rejects malformed ones', () => {
  assert.equal(readFunnelNode(nodes[0]).offer.amount_cents, 4700);
  assert.equal(readFunnelNode({ id: 'x' }), null);
  assert.equal(readFunnelNode(null), null);
  assert.equal(readFunnelNode({ id: 'x', offer: { amount_cents: 'NaN', name: 'bad' } }), null);
  assert.deepEqual(readFunnelNode({ id: 'x', offer: { amount_cents: 1, name: 'n', recurring: 'month' }, transitions: [{ on: 'a' }, 5, { on: 'b', to: 'y' }], route_path: '/r', offer_ref: 'o', proof_gate: 'g' }),
    { id: 'x', entry: false, offer: { amount_cents: 1, name: 'n', recurring: 'month' }, proof_gate: 'g', transitions: [{ on: 'b', to: 'y' }], route_path: '/r', offer_ref: 'o' });
});

test('resolves entry, steps and breadth-first order from the records alone', () => {
  const flow = resolveFunnelFlow(graphs, nodes);
  assert.equal(flow.graph_id, 'graph:ladder');
  assert.equal(flow.entry.id, 'front');
  assert.deepEqual(flow.order, ['front', 'bump', 'core']);
  assert.equal(flow.entry.price_source, 'node-offer');
  assert.equal(flow.entry.display_amount_cents, 4700);
});

test('a graph that names no entry falls back to the node marked entry, and a named graph is chosen by id', () => {
  const flow = resolveFunnelFlow([{ id: 'graph:other' }, { id: 'graph:ladder' }], nodes, [], [], [], 'ladder');
  assert.equal(flow.graph_id, 'graph:ladder');
  assert.equal(flow.entry.id, 'front');
});

test('a cycle ends where it comes back', () => {
  const loop = [node('a', 1, [{ on: 'x', to: 'b' }], { entry: true }), node('b', 2, [{ on: 'x', to: 'a' }])];
  assert.deepEqual(resolveFunnelFlow([{ id: 'g', entry_node: 'a' }], loop).order, ['a', 'b']);
});

test('the entry price is a settled experiment winner and says which record decided it; other nodes keep their own', () => {
  const experiments = [{ id: 'exp:front-price', state: 'graduated', node_ref: 'node::front', result: { winner: 'v-37' } }];
  const flow = resolveFunnelFlow(graphs, nodes, experiments, [{ variant_key: 'v-37', amount_cents: 3700 }]);
  assert.equal(flow.entry.display_amount_cents, 3700);
  assert.equal(flow.entry.price_source, 'experiment-winner');
  assert.equal(flow.entry.price_source_ref, 'exp:front-price');
  assert.equal(flow.steps.bump.display_amount_cents, 9700);
});

test('a running experiment never decides a live price, and a winner no variant prices decides nothing', () => {
  const variants = [{ variant_key: 'v-1', amount_cents: 100 }];
  assert.equal(resolveFunnelFlow(graphs, nodes, [{ id: 'exp:running', state: 'running', node_ref: 'front', result: { winner: 'v-1' } }], variants).entry.price_source, 'node-offer');
  assert.equal(resolveFunnelFlow(graphs, nodes, [{ id: 'exp:done', state: 'settled', node_ref: 'front', result: { winner: '47' } }], variants).entry.price_source, 'node-offer');
  assert.equal(resolveFunnelFlow(graphs, nodes, [{ id: 'exp:done', state: 'settled', node_ref: 'front', result: { winner: 'v-1' } }], [{ variant_key: 'v-1', amount_cents: 100, status: 'inactive' }]).entry.price_source, 'node-offer');
});

test('a winner resolves through the offer-experiment idea-ref chain and a variant record', () => {
  const offerExperiments = [{ node_ref: 'node::front', outcome_links: { outcome: 'idea-ref:idea::front-price' } }];
  const experiments = [{ id: 'exp:linked', state: 'settled', idea_ref: 'idea::front-price', result: { winner: 'v-a' } }];
  assert.deepEqual(resolveExperimentWinnerAmount('front', experiments, [{ variant_key: 'v-a', amount_cents: 2900 }], offerExperiments), { amount_cents: 2900, ref: 'exp:linked' });
  assert.equal(resolveExperimentWinnerAmount('other', experiments, [{ variant_key: 'v-a', amount_cents: 2900 }], offerExperiments), null);
});

test('fail-soft: no graph or no entry node gives null, never a throw', () => {
  assert.equal(resolveFunnelFlow([], nodes), null);
  assert.equal(resolveFunnelFlow(graphs, []), null);
  assert.equal(resolveFunnelFlow([{ id: 'g' }], [node('a', 100, [])]), null);
});

test('advanceFunnel follows the outcome transition, ends at a target that is not a node, and fails soft', () => {
  const flow = resolveFunnelFlow(graphs, nodes);
  const first = advanceFunnel(flow, 'front', 'purchase');
  assert.equal(first.next.id, 'bump');
  assert.equal(first.terminal, false);
  assert.deepEqual(advanceFunnel(flow, 'core', 'purchase'), { next: null, target: 'thank-you', terminal: true });
  const declined = advanceFunnel(flow, 'front', 'decline');
  assert.equal(declined.target, 'exit');
  assert.equal(declined.terminal, true);
  assert.equal(advanceFunnel(flow, 'nope', 'purchase').terminal, true);
  assert.equal(advanceFunnel(flow, 'front', 'made-up-outcome').terminal, true);
});

test('a missing or unknown cursor starts at the entry', () => {
  const flow = resolveFunnelFlow(graphs, nodes);
  assert.equal(funnelStepAtCursor(flow, undefined).id, 'front');
  assert.equal(funnelStepAtCursor(flow, 'ghost').id, 'front');
  assert.equal(funnelStepAtCursor(flow, 'bump').id, 'bump');
});

test('call-to-action links: one page, primary first, malformed dropped', () => {
  const records = [
    { page: 'p:home', label: 'Learn more', role: 'secondary', href: '/about' },
    { page: 'p:home', label: 'Buy now', role: 'primary', href: '/buy', attribution_key: 'utm_source=x' },
    { page: 'p:other', label: 'Elsewhere', href: '/x' },
    { page: 'p:home', href: '/broken' },
  ];
  const links = resolveCtaLinks(records, 'p:home');
  assert.deepEqual(links.map(link => link.label), ['Buy now', 'Learn more']);
  assert.equal(links[0].attribution, 'utm_source=x');
  assert.equal(resolveCtaLinks(records).length, 3);
});
