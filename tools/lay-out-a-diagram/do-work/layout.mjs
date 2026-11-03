// tools/lay-out-a-diagram/do-work/layout.mjs
//
// The layered layout of a diagram of boxes and arrows. Pure and deterministic: the same nodes, edges and settings always give the
// same positions. Every number it uses (spacing, port pitch, sweep count, label advances) is a row of read-data/layout-settings.json.
//
// The steps, in order: measure each box, break cycles by reversing the arrows that close them, give every box a rank (a layer),
// put a virtual point on every rank a long arrow crosses, order the boxes inside each rank so few arrows cross, give each box a
// place across its rank, spread the arrow ends along each side of a box, and route every arrow as a list of points.
//
// Inside the layout the two axes are `across` (along a rank) and `primary` (from rank to rank). Direction "down" is across = x,
// primary = y; direction "right" swaps them in the last step.

const round2 = value => Math.round(value * 100) / 100;
const sum = values => values.reduce((total, value) => total + value, 0);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * How many pairs of segments between two adjacent ranks cross. A pair is [position in the upper rank, position in the lower
 * rank]. Sorted by upper position, a crossing is an earlier segment whose lower position is greater, counted with a Fenwick tree
 * over the lower positions: O(E log V), not a loop over every pair.
 */
export function countCrossings(pairs, lowerSize) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const tree = new Int32Array(lowerSize + 1);
  let crossings = 0;
  sorted.forEach(([, lower], seen) => {
    let notGreater = 0;
    for (let at = lower + 1; at > 0; at -= at & -at) notGreater += tree[at];
    crossings += seen - notGreater;
    for (let at = lower + 1; at <= lowerSize; at += at & -at) tree[at] += 1;
  });
  return crossings;
}

function measurer(settings) {
  const table = new Map();
  for (const { width, characters } of settings.advance.groups) for (const character of characters) table.set(character, width);
  const isWide = code => settings.advance.wide_ranges.some(([low, high]) => code >= low && code <= high);
  return text => {
    let em = 0;
    for (const character of text) em += table.get(character) ?? (isWide(character.codePointAt(0)) ? settings.advance.wide : settings.advance.default);
    return em * settings.font.size;
  };
}

function prepare(input, settings) {
  const measure = measurer(settings);
  const lanes = input.lanes ?? null;
  const nodes = input.nodes.map((node, index) => ({
    id: node.id,
    index,
    lane: node.lane ?? null,
    laneIndex: lanes ? lanes.indexOf(node.lane) : 0,
    width: node.width ?? Math.max(settings.node.min_width, Math.ceil(measure(node.label ?? node.id)) + 2 * settings.node.padding_x),
    height: node.height ?? Math.max(settings.node.min_height, Math.ceil(settings.font.size * settings.font.line_height) + 2 * settings.node.padding_y),
  }));
  const at = new Map(nodes.map(node => [node.id, node.index]));
  const edges = input.edges.map((edge, index) => ({ id: edge.id ?? `e${index}`, index, from: at.get(edge.from), to: at.get(edge.to), label: edge.label ?? null }));
  return { nodes, edges, lanes, vertical: (input.direction ?? 'down') === 'down' };
}

/** The arrows to reverse so none closes a cycle: depth first in declaration order; an arrow into a box still on the stack is reversed. */
function breakCycles(count, edges) {
  const out = Array.from({ length: count }, () => []);
  for (const edge of edges) if (edge.from !== edge.to) out[edge.from].push(edge);
  const state = new Uint8Array(count);
  const reversed = new Set();
  const visit = node => {
    state[node] = 1;
    for (const edge of out[node]) {
      if (state[edge.to] === 1) reversed.add(edge.index);
      else if (state[edge.to] === 0) visit(edge.to);
    }
    state[node] = 2;
  };
  for (let node = 0; node < count; node++) if (state[node] === 0) visit(node);
  return reversed;
}

/** Longest path from the sources, then every box with room to spare moves down to just above its nearest successor. */
function rankNodes(count, links) {
  const successors = Array.from({ length: count }, () => []);
  const waiting = new Int32Array(count);
  for (const { source, target } of links) { successors[source].push(target); waiting[target] += 1; }
  const queue = [];
  for (let node = 0; node < count; node++) if (waiting[node] === 0) queue.push(node);
  const rank = new Int32Array(count);
  for (let at = 0; at < queue.length; at++) {
    for (const next of successors[queue[at]]) {
      rank[next] = Math.max(rank[next], rank[queue[at]] + 1);
      if (--waiting[next] === 0) queue.push(next);
    }
  }
  for (let at = queue.length - 1; at >= 0; at--) {
    const node = queue[at];
    if (successors[node].length) rank[node] = Math.max(rank[node], Math.min(...successors[node].map(next => rank[next])) - 1);
  }
  return rank;
}

/** Items are the boxes plus one virtual point on each rank a long arrow crosses, so every segment joins two adjacent ranks. */
function buildGraph(nodes, links, rank) {
  const items = nodes.map((node, at) => ({ node: at, rank: rank[at], lane: node.laneIndex }));
  const chains = links.map(link => {
    const chain = [link.source];
    for (let at = rank[link.source] + 1; at < rank[link.target]; at++) {
      items.push({ node: null, rank: at, lane: nodes[link.source].laneIndex });
      chain.push(items.length - 1);
    }
    chain.push(link.target);
    return { edge: link.edge, items: chain };
  });
  const rankCount = nodes.length ? Math.max(...rank) + 1 : 0;
  const up = items.map(() => []);
  const down = items.map(() => []);
  const segments = Array.from({ length: Math.max(rankCount - 1, 0) }, () => []);
  for (const { items: chain } of chains) {
    for (let at = 0; at + 1 < chain.length; at++) {
      segments[items[chain[at]].rank].push([chain[at], chain[at + 1]]);
      down[chain[at]].push(chain[at + 1]);
      up[chain[at + 1]].push(chain[at]);
    }
  }
  return { items, chains, up, down, segments, rankCount };
}

const positionsOf = (order, itemCount) => {
  const position = new Int32Array(itemCount);
  for (const list of order) list.forEach((item, at) => { position[item] = at; });
  return position;
};

function totalCrossings(graph, order) {
  const position = positionsOf(order, graph.items.length);
  return sum(graph.segments.map((pairs, rank) => countCrossings(pairs.map(([upper, lower]) => [position[upper], position[lower]]), order[rank + 1].length)));
}

function startingOrder(graph) {
  const order = Array.from({ length: graph.rankCount }, () => []);
  graph.items.forEach((item, at) => order[item.rank].push(at));
  for (const list of order) list.sort((a, b) => graph.items[a].lane - graph.items[b].lane || a - b);
  return order;
}

/** Each item moves to the mean position of its neighbours on the rank above (downward) or below (upward); a lane keeps its block. */
function barycenterSweep(graph, order, downward) {
  const next = order.map(list => [...list]);
  const position = positionsOf(next, graph.items.length);
  const key = new Float64Array(graph.items.length);
  const ranks = Array.from({ length: Math.max(graph.rankCount - 1, 0) }, (_, at) => (downward ? at + 1 : graph.rankCount - 2 - at));
  for (const rank of ranks) {
    for (const item of next[rank]) {
      const near = (downward ? graph.up : graph.down)[item];
      key[item] = near.length ? sum(near.map(other => position[other])) / near.length : position[item];
    }
    next[rank].sort((a, b) => graph.items[a].lane - graph.items[b].lane || key[a] - key[b] || position[a] - position[b]);
    next[rank].forEach((item, at) => { position[item] = at; });
  }
  return next;
}

/** Swap two neighbours of one lane whenever that lowers the exact number of crossings the pair takes part in. */
function transpose(graph, order) {
  const next = order.map(list => [...list]);
  const position = positionsOf(next, graph.items.length);
  const crossingsOf = (left, right) => {
    let count = 0;
    for (const side of [graph.up, graph.down]) for (const a of side[left]) for (const b of side[right]) if (position[a] > position[b]) count += 1;
    return count;
  };
  for (let improved = true; improved;) {
    improved = false;
    for (const list of next) {
      for (let at = 0; at + 1 < list.length; at++) {
        const [left, right] = [list[at], list[at + 1]];
        if (graph.items[left].lane !== graph.items[right].lane || crossingsOf(right, left) >= crossingsOf(left, right)) continue;
        [list[at], list[at + 1]] = [right, left];
        position[right] = at;
        position[left] = at + 1;
        improved = true;
      }
    }
  }
  return next;
}

/** The configured number of sweeps; a new order is kept only when its exact crossing count does not rise. */
function reduceCrossings(graph, start, sweeps) {
  let order = start;
  let best = totalCrossings(graph, order);
  for (let sweep = 0; sweep < sweeps && best > 0; sweep++) {
    for (const step of [current => barycenterSweep(graph, current, true), current => barycenterSweep(graph, current, false), current => transpose(graph, current)]) {
      const next = step(order);
      const count = totalCrossings(graph, next);
      if (count <= best) { order = next; best = count; }
    }
  }
  return { order, crossings: best };
}

/** Where each item sits across its rank: packed and centred in its lane's band, then pulled toward the median of its neighbours. */
function placeAcross(graph, order, across, bandCount, laned, settings) {
  const gapBetween = (a, b) => (graph.items[a].node !== null && graph.items[b].node !== null ? settings.spacing.node : settings.spacing.virtual);
  const groups = order.map(list => Array.from({ length: bandCount }, (_, band) => list.filter(item => graph.items[item].lane === band)).filter(items => items.length));
  const widthOf = items => sum(items.map(item => across[item])) + sum(items.slice(1).map((item, at) => gapBetween(items[at], item)));
  const bandWidth = Array.from({ length: bandCount }, (_, band) => Math.max(0, ...groups.flat().filter(items => graph.items[items[0]].lane === band).map(widthOf)));
  const bandStart = bandWidth.map((_, band) => sum(bandWidth.slice(0, band)) + band * settings.spacing.lane);
  const centre = new Float64Array(graph.items.length);

  const settle = (items, desired) => {
    const band = graph.items[items[0]].lane;
    const [low, high] = laned ? [bandStart[band], bandStart[band] + bandWidth[band]] : [-Infinity, Infinity];
    const at = [...desired];
    at[0] = Math.max(at[0], low + across[items[0]] / 2);
    for (let i = 1; i < items.length; i++) at[i] = Math.max(at[i], at[i - 1] + across[items[i - 1]] / 2 + gapBetween(items[i - 1], items[i]) + across[items[i]] / 2);
    const last = items.length - 1;
    at[last] = Math.min(at[last], high - across[items[last]] / 2);
    for (let i = last - 1; i >= 0; i--) at[i] = Math.min(at[i], at[i + 1] - across[items[i + 1]] / 2 - gapBetween(items[i], items[i + 1]) - across[items[i]] / 2);
    items.forEach((item, i) => { centre[item] = at[i]; });
  };

  for (const rankGroups of groups) {
    for (const items of rankGroups) {
      const band = graph.items[items[0]].lane;
      let cursor = bandStart[band] + (bandWidth[band] - widthOf(items)) / 2;
      settle(items, items.map((item, i) => {
        if (i) cursor += gapBetween(items[i - 1], item);
        const at = cursor + across[item] / 2;
        cursor += across[item];
        return at;
      }));
    }
  }
  const relax = (rank, near) => {
    for (const items of groups[rank]) settle(items, items.map(item => (near[item].length ? median(near[item].map(other => centre[other])) : centre[item])));
  };
  for (let pass = 0; pass < settings.coordinate_passes; pass++) {
    for (let rank = 1; rank < graph.rankCount; rank++) relax(rank, graph.up);
    for (let rank = graph.rankCount - 2; rank >= 0; rank--) relax(rank, graph.down);
  }
  return centre;
}

/** Arrows meeting one side of a box spread along it at the port pitch (closer only when the side is short), centred, never nearer than the minimum gap. */
function spreadPorts(graph, centre, across, settings) {
  const ends = graph.items.map(() => ({ bottom: [], top: [] }));
  graph.chains.forEach(({ items: chain }, at) => {
    ends[chain[0]].bottom.push({ chain: at, other: chain[1] });
    ends[chain.at(-1)].top.push({ chain: at, other: chain.at(-2) });
  });
  const port = graph.chains.map(() => [0, 0]);
  graph.items.forEach((item, at) => {
    if (item.node === null) return;
    for (const [side, slot] of [['bottom', 0], ['top', 1]]) {
      const list = [...ends[at][side]].sort((a, b) => centre[a.other] - centre[b.other] || a.chain - b.chain);
      const pitch = list.length > 1 ? Math.min(settings.ports.pitch, (across[at] - 2 * settings.ports.min_gap) / (list.length - 1)) : 0;
      list.forEach(({ chain }, i) => { port[chain][slot] = centre[at] + (i - (list.length - 1) / 2) * pitch; });
    }
  });
  return port;
}

/** A box wide enough that the arrows on its busiest side can keep the minimum gap between them and from the corners. */
function widthForPorts(graph, across, settings) {
  const count = graph.items.map(() => ({ top: 0, bottom: 0 }));
  for (const { items: chain } of graph.chains) { count[chain[0]].bottom += 1; count[chain.at(-1)].top += 1; }
  return across.map((size, at) => (graph.items[at].node === null ? size : Math.max(size, (Math.max(count[at].top, count[at].bottom, 1) + 1) * settings.ports.min_gap)));
}

/**
 * Lay out a diagram. `input` is { nodes: [{ id, label?, width?, height?, lane? }], edges: [{ id?, from, to, label? }], direction?, lanes? }
 * already checked by requests.mjs. Answers positions, arrow routes and quality numbers.
 */
export function layOut(input, settings) {
  const { nodes, edges, lanes, vertical } = prepare(input, settings);
  const reversed = breakCycles(nodes.length, edges);
  const links = edges.filter(edge => edge.from !== edge.to).map(edge => (reversed.has(edge.index)
    ? { edge: edge.index, source: edge.to, target: edge.from }
    : { edge: edge.index, source: edge.from, target: edge.to }));
  const graph = buildGraph(nodes, links, rankNodes(nodes.length, links));
  const start = startingOrder(graph);
  const crossingsBefore = totalCrossings(graph, start);
  const { order, crossings: crossingsAfter } = reduceCrossings(graph, start, settings.crossing_sweeps);

  const across = widthForPorts(graph, graph.items.map(item => (item.node === null ? settings.spacing.virtual_width : (vertical ? nodes[item.node].width : nodes[item.node].height))), settings);
  const along = graph.items.map(item => (item.node === null ? 0 : (vertical ? nodes[item.node].height : nodes[item.node].width)));
  const centre = placeAcross(graph, order, across, lanes ? lanes.length : 1, lanes !== null, settings);
  const port = spreadPorts(graph, centre, across, settings);

  const rankSize = order.map(list => Math.max(0, ...list.map(item => along[item])));
  const rankStart = rankSize.map((_, rank) => sum(rankSize.slice(0, rank)) + rank * settings.spacing.rank);
  const top = graph.items.map((item, at) => rankStart[item.rank] + (rankSize[item.rank] - along[at]) / 2);
  const toXY = ([a, p]) => (vertical ? [a, p] : [p, a]);

  const boxes = nodes.map(node => {
    const [a, p, sa, sp] = [centre[node.index], top[node.index], across[node.index], along[node.index]];
    return vertical ? { x: a - sa / 2, y: p, width: sa, height: sp } : { x: p, y: a - sa / 2, width: sp, height: sa };
  });
  const routeOf = new Map(graph.chains.map(({ edge, items: chain }, at) => {
    const points = [[port[at][0], top[chain[0]] + along[chain[0]]]];
    for (const item of chain.slice(1, -1)) points.push([centre[item], rankStart[graph.items[item].rank] + rankSize[graph.items[item].rank] / 2]);
    points.push([port[at][1], top[chain.at(-1)]]);
    const real = points.map(toXY);
    return [edge, reversed.has(edge) ? real.reverse() : real];
  }));
  const routes = edges.map(edge => {
    if (edge.from !== edge.to) return routeOf.get(edge.index);
    const { x, y, width, height } = boxes[edge.from];
    const out = x + width + settings.spacing.loop;
    return [[x + width, y + height * 0.35], [out, y + height * 0.35], [out, y + height * 0.65], [x + width, y + height * 0.65]];
  });

  const xs = [...boxes.flatMap(box => [box.x, box.x + box.width]), ...routes.flat().map(point => point[0])];
  const ys = [...boxes.flatMap(box => [box.y, box.y + box.height]), ...routes.flat().map(point => point[1])];
  const [left, topEdge] = [Math.min(...xs), Math.min(...ys)];
  const realOrder = order.map(list => list.filter(item => graph.items[item].node !== null));
  const orderOf = new Int32Array(nodes.length);
  for (const list of realOrder) list.forEach((item, at) => { orderOf[item] = at; });

  return {
    width: round2(Math.max(...xs) - left),
    height: round2(Math.max(...ys) - topEdge),
    nodes: nodes.map(node => ({
      id: node.id,
      x: round2(boxes[node.index].x - left),
      y: round2(boxes[node.index].y - topEdge),
      width: round2(boxes[node.index].width),
      height: round2(boxes[node.index].height),
      rank: graph.items[node.index].rank,
      order: orderOf[node.index],
      lane: node.lane,
    })),
    edges: edges.map(edge => ({
      id: edge.id,
      from: nodes[edge.from].id,
      to: nodes[edge.to].id,
      points: routes[edge.index].map(([x, y]) => [round2(x - left), round2(y - topEdge)]),
      reversed: reversed.has(edge.index),
      label: edge.label,
    })),
    quality: {
      crossings_before: crossingsBefore,
      crossings_after: crossingsAfter,
      reversed_edges: reversed.size,
      ranks: graph.rankCount,
      virtual_points: graph.items.filter(item => item.node === null).length,
    },
  };
}
