// tools/lay-out-a-diagram: the layered layout. Made-up boxes only ("Order received", "Packed"); nothing here is anyone's real diagram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countCrossings, layOut } from '../do-work/layout.mjs';
import settings from '../read-data/layout-settings.json' with { type: 'json' };

const lay = request => layOut(request, settings);
const nodesOf = (...ids) => ids.map(id => ({ id }));
const link = (from, to) => ({ from, to });
const byId = (layout, id) => layout.nodes.find(node => node.id === id);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.02, `${message}: ${actual} is not ${expected}`);

// A tiny deterministic generator so the random graphs are the same on every run.
function seeded(seed) {
  let state = seed;
  return limit => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * limit);
  };
}

const bruteForce = pairs => {
  let crossings = 0;
  for (let first = 0; first < pairs.length; first++) {
    for (let second = first + 1; second < pairs.length; second++) {
      if ((pairs[first][0] - pairs[second][0]) * (pairs[first][1] - pairs[second][1]) < 0) crossings += 1;
    }
  }
  return crossings;
};

test('an arrow that closes a cycle is reversed for the layout, reported, and drawn in its real direction', () => {
  const layout = lay({ nodes: nodesOf('Order received', 'Packed', 'Shipped'), edges: [link('Order received', 'Packed'), link('Packed', 'Shipped'), link('Shipped', 'Order received')] });
  assert.equal(layout.quality.reversed_edges, 1);
  assert.deepEqual(layout.edges.map(edge => edge.reversed), [false, false, true]);
  assert.deepEqual(layout.nodes.map(node => node.rank), [0, 1, 2]);
  const closing = layout.edges[2];
  assert.deepEqual([closing.from, closing.to], ['Shipped', 'Order received']);
  assert.ok(closing.points[0][1] > closing.points.at(-1)[1], 'the arrow starts at Shipped, below, and ends at Order received, above');
});

test('ranks of a chain and of a diamond, and a box with room to spare moves down next to its successor', () => {
  const chain = lay({ nodes: nodesOf('a', 'b', 'c'), edges: [link('a', 'b'), link('b', 'c')] });
  assert.deepEqual(chain.nodes.map(node => node.rank), [0, 1, 2]);
  const diamond = lay({ nodes: nodesOf('a', 'b', 'c', 'd'), edges: [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')] });
  assert.deepEqual(diamond.nodes.map(node => node.rank), [0, 1, 1, 2]);
  const slack = lay({ nodes: nodesOf('a', 'b', 'c', 'late'), edges: [link('a', 'b'), link('b', 'c'), link('late', 'c')] });
  assert.equal(byId(slack, 'late').rank, 1);
  assert.equal(slack.quality.virtual_points, 0);
});

test('an arrow across two ranks gets a point on the rank between and a route through it', () => {
  const layout = lay({ nodes: nodesOf('a', 'b', 'c'), edges: [link('a', 'b'), link('b', 'c'), link('a', 'c')] });
  assert.equal(layout.quality.virtual_points, 1);
  assert.equal(layout.edges[2].points.length, 3);
  assert.equal(layout.quality.ranks, 3);
});

test('declaration order that crosses two arrows gives an order with none', () => {
  const layout = lay({ nodes: nodesOf('A', 'B', 'C', 'D'), edges: [link('A', 'D'), link('B', 'C')] });
  assert.deepEqual([layout.quality.crossings_before, layout.quality.crossings_after], [1, 0]);
  assert.ok(byId(layout, 'D').order < byId(layout, 'C').order);
});

test('the Fenwick crossing count equals a count over every pair, on seeded random segments', () => {
  const next = seeded(7);
  for (let trial = 0; trial < 300; trial++) {
    const upper = 1 + next(8);
    const lower = 1 + next(8);
    const pairs = Array.from({ length: next(25) }, () => [next(upper), next(lower)]);
    assert.equal(countCrossings(pairs, lower), bruteForce(pairs), JSON.stringify(pairs));
  }
});

test('on seeded random layered graphs the reported crossings are the real ones, never more than at the start, and no boxes overlap', () => {
  const next = seeded(11);
  for (let trial = 0; trial < 40; trial++) {
    const sizes = Array.from({ length: 2 + next(3) }, () => 1 + next(4));
    const names = sizes.map((size, layer) => Array.from({ length: size }, (_, at) => `n${layer}_${at}`));
    const edges = [];
    names.forEach((layer, at) => {
      if (at === 0) return;
      for (const name of layer) {
        edges.push(link(names[at - 1][next(names[at - 1].length)], name));
        if (next(2)) edges.push(link(names[at - 1][next(names[at - 1].length)], name));
      }
    });
    const nodes = names.flat().map(id => ({ id }));
    for (let at = nodes.length - 1; at > 0; at--) { const other = next(at + 1); [nodes[at], nodes[other]] = [nodes[other], nodes[at]]; }
    const layout = lay({ nodes, edges });
    const rankOf = new Map(layout.nodes.map(node => [node.id, node]));
    const perRank = new Map();
    for (const edge of edges) {
      const [upper, lower] = [rankOf.get(edge.from), rankOf.get(edge.to)];
      perRank.set(upper.rank, [...(perRank.get(upper.rank) ?? []), [upper.order, lower.order]]);
    }
    assert.equal(layout.quality.crossings_after, [...perRank.values()].reduce((total, pairs) => total + bruteForce(pairs), 0), `trial ${trial}`);
    assert.ok(layout.quality.crossings_after <= layout.quality.crossings_before);
    for (const first of layout.nodes) {
      for (const second of layout.nodes) {
        if (first.id >= second.id) continue;
        const apart = first.x + first.width <= second.x + 0.01 || second.x + second.width <= first.x + 0.01 || first.y + first.height <= second.y + 0.01 || second.y + second.height <= first.y + 0.01;
        assert.ok(apart, `${first.id} and ${second.id} overlap in trial ${trial}`);
      }
    }
  }
});

test('lanes keep their bands and the same rank lines up across lanes', () => {
  const nodes = [
    { id: 'Order received', lane: 'Customer' }, { id: 'Confirmed', lane: 'Customer' },
    { id: 'Picked', lane: 'Warehouse' }, { id: 'Packed', lane: 'Warehouse' }, { id: 'Delivered', lane: 'Customer' },
  ];
  const edges = [link('Order received', 'Confirmed'), link('Order received', 'Picked'), link('Picked', 'Packed'), link('Confirmed', 'Delivered'), link('Packed', 'Delivered')];
  const layout = lay({ nodes, edges, lanes: ['Customer', 'Warehouse'] });
  const inLane = lane => layout.nodes.filter(node => node.lane === lane);
  const rightEdge = Math.max(...inLane('Customer').map(node => node.x + node.width));
  assert.ok(Math.min(...inLane('Warehouse').map(node => node.x)) >= rightEdge, 'the Warehouse band starts after the Customer band ends');
  assert.equal(byId(layout, 'Confirmed').rank, byId(layout, 'Packed').rank);
  close(byId(layout, 'Confirmed').y, byId(layout, 'Packed').y, 'two boxes of one rank in different lanes');
});

test('arrows meeting one side of a box spread at the port pitch, centred on the box', () => {
  const layout = lay({ nodes: nodesOf('Order received', 'x', 'y', 'z'), edges: [link('Order received', 'x'), link('Order received', 'y'), link('Order received', 'z')] });
  const source = byId(layout, 'Order received');
  const starts = layout.edges.map(edge => edge.points[0][0]).sort((a, b) => a - b);
  close(starts[1] - starts[0], settings.ports.pitch, 'first gap');
  close(starts[2] - starts[1], settings.ports.pitch, 'second gap');
  close((starts[0] + starts[2]) / 2, source.x + source.width / 2, 'centre of the ports');
  for (const edge of layout.edges) close(edge.points[0][1], source.y + source.height, 'leaves from the bottom side');
});

test('a short side keeps the arrows at least the minimum gap apart by making the box wider', () => {
  const targets = Array.from({ length: 12 }, (_, at) => `t${at}`);
  const layout = lay({ nodes: nodesOf('s', ...targets), edges: targets.map(target => link('s', target)) });
  const starts = layout.edges.map(edge => edge.points[0][0]).sort((a, b) => a - b);
  for (let at = 1; at < starts.length; at++) assert.ok(starts[at] - starts[at - 1] >= settings.ports.min_gap - 0.02);
  const source = byId(layout, 's');
  assert.ok(starts[0] > source.x && starts.at(-1) < source.x + source.width);
});

test('direction right swaps the axes', () => {
  const request = { nodes: nodesOf('a', 'b', 'c'), edges: [link('a', 'b'), link('b', 'c')] };
  const down = lay(request);
  const right = lay({ ...request, direction: 'right' });
  assert.ok(down.nodes[1].y > down.nodes[0].y && Math.abs(down.nodes[1].x - down.nodes[0].x) < 0.02);
  assert.ok(right.nodes[1].x > right.nodes[0].x && Math.abs(right.nodes[1].y - right.nodes[0].y) < 0.02);
  assert.ok(right.width > right.height && down.height > down.width);
});

test('the same request always gives the same answer', () => {
  const request = {
    nodes: nodesOf('a', 'b', 'c', 'd', 'e'),
    edges: [link('a', 'd'), link('b', 'c'), link('c', 'e'), link('a', 'e'), link('e', 'a'), link('b', 'b')],
  };
  assert.deepEqual(lay(request), lay(structuredClone(request)));
});

test('a self-loop stays out of the ranking and is drawn as a small loop', () => {
  const layout = lay({ nodes: nodesOf('a', 'b'), edges: [link('a', 'a'), link('a', 'b')] });
  assert.deepEqual(layout.nodes.map(node => node.rank), [0, 1]);
  assert.equal(layout.edges[0].points.length, 4);
  assert.equal(layout.edges[0].reversed, false);
  assert.equal(layout.quality.reversed_edges, 0);
});

test('a given size is kept, a measured one grows with the label, and the drawing starts at 0,0', () => {
  const layout = lay({ nodes: [{ id: 'fixed', width: 200, height: 80 }, { id: 'short' }, { id: 'a much longer label than the other' }], edges: [] });
  assert.deepEqual([byId(layout, 'fixed').width, byId(layout, 'fixed').height], [200, 80]);
  assert.ok(byId(layout, 'a much longer label than the other').width > byId(layout, 'short').width);
  assert.ok(byId(layout, 'short').width >= settings.node.min_width);
  assert.equal(Math.min(...layout.nodes.map(node => node.x)), 0);
  assert.equal(Math.min(...layout.nodes.map(node => node.y)), 0);
});
