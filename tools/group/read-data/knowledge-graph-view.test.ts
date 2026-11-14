// packages/group/read-data/knowledge-graph-view.test.ts
//
// Offline (no browser / no studio) proof of the knowledge-graph surface view
// builder: a raw connection-graph projection becomes positioned graph-canvas
// frames + edge routes, with honest missing-record stubs, hyper-connection hubs,
// and an empty view for empty input. This is the "local/preview proof" for the
// W8 graph surface up to the (studio-recovery) deploy boundary.

import { describe, expect, it } from 'vitest';
import { buildKnowledgeGraphView } from './knowledge-graph-view';

const finite = (n: number) => Number.isFinite(n);

describe('buildKnowledgeGraphView', () => {
  it('turns a 2-node/1-edge projection into positioned frames + one edge route', () => {
    const view = buildKnowledgeGraphView({
      nodes: [
        { id: 'entity/ada', attributes: { label: 'Ada' } },
        { id: 'entity/ben', attributes: { label: 'Ben' } },
      ],
      connections: [
        { id: 'p1', endpoints: [{ role: 'from', node_id: 'entity/ada' }, { role: 'to', node_id: 'entity/ben' }], attributes: { relation: 'coached' } },
      ],
    });
    expect(view.frames).toHaveLength(2);
    expect(view.frames.every((f) => finite(f.x) && finite(f.y) && f.width > 0 && f.height > 0)).toBe(true);
    expect(view.edgeRoutes).toHaveLength(1);
    expect(view.edgeRoutes[0].points).toHaveLength(2);
    expect(view.edgeRoutes[0].points.every((p) => finite(p.x) && finite(p.y))).toBe(true);
    // Human labels present (no jargon leaked as the label).
    const labels = [...view.nodes.values()].map((n) => n.label).sort();
    expect(labels).toEqual(['Ada', 'Ben']);
    expect(view.diagnostics).toMatchObject({ nodeCount: 2, edgeCount: 1 });
  });

  it('renders an honest empty view for an empty projection — no fake nodes (L117)', () => {
    const view = buildKnowledgeGraphView({ nodes: [], connections: [] });
    expect(view.frames).toEqual([]);
    expect(view.edgeRoutes).toEqual([]);
    expect(view.nodes.size).toBe(0);
    expect(view.diagnostics.edgeCount).toBe(0);
  });

  it('renders a dangling edge endpoint as an honest "missing record" stub, never dropped silently', () => {
    const view = buildKnowledgeGraphView({
      nodes: [{ id: 'entity/ada', attributes: { label: 'Ada' } }],
      connections: [{ id: 'p1', endpoints: [{ node_id: 'entity/ada' }, { node_id: 'entity/ghost' }], attributes: {} }],
    });
    const ghost = [...view.nodes.values()].find((n) => n.missing);
    expect(ghost).toBeTruthy();
    expect(ghost?.label).toBe('Missing record');
    expect(view.diagnostics.missingEndpointCount).toBe(1);
    // The edge still routes between ada and the stub (both laid out).
    expect(view.edgeRoutes).toHaveLength(1);
  });

  it('renders a hyper-connection (>2 participants) as a hub + spokes, not a pairwise explosion', () => {
    const view = buildKnowledgeGraphView({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      connections: [{ id: 'set/1', endpoints: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }], attributes: { label: 'meeting' } }],
    });
    const hub = [...view.nodes.values()].find((n) => n.hub);
    expect(hub).toBeTruthy();
    expect(view.diagnostics.hubCount).toBe(1);
    // 3 spokes (hub→a, hub→b, hub→c), not 3 pairwise edges.
    expect(view.edgeRoutes).toHaveLength(3);
  });

  it('DENSE state: 40 nodes / 44 edges lay out spread (finite, no origin-collapse) — the reference-lock dense render-state', () => {
    // The package-UI-reference-lock render-state matrix requires proving the
    // dense case. A force-directed layout that collapsed every node to (0,0)
    // would render a black dot, not a graph — assert real spatial separation.
    const N = 40;
    const nodes = Array.from({ length: N }, (_, i) => ({ id: `n${i}`, attributes: { label: `Node ${i}` } }));
    const chain = Array.from({ length: N - 1 }, (_, i) => ({
      id: `e${i}`, endpoints: [{ role: 'from', node_id: `n${i}` }, { role: 'to', node_id: `n${i + 1}` }], attributes: { relation: 'next' },
    }));
    const cross = [
      { id: 'x0', endpoints: [{ node_id: 'n0' }, { node_id: 'n20' }], attributes: {} },
      { id: 'x1', endpoints: [{ node_id: 'n5' }, { node_id: 'n35' }], attributes: {} },
      { id: 'x2', endpoints: [{ node_id: 'n10' }, { node_id: 'n30' }], attributes: {} },
      { id: 'x3', endpoints: [{ node_id: 'n2' }, { node_id: 'n39' }], attributes: {} },
      { id: 'x4', endpoints: [{ node_id: 'n15' }, { node_id: 'n25' }], attributes: {} },
    ];
    const view = buildKnowledgeGraphView({ nodes, connections: [...chain, ...cross] });

    expect(view.frames).toHaveLength(N);
    expect(view.frames.every((f) => finite(f.x) && finite(f.y) && f.width > 0 && f.height > 0)).toBe(true);
    // No origin-collapse: the layout occupies a real 2-D bounding box.
    const xs = view.frames.map((f) => f.x), ys = view.frames.map((f) => f.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
    // Nodes are actually separated, not stacked on one point.
    const distinct = new Set(view.frames.map((f) => `${f.x},${f.y}`)).size;
    expect(distinct).toBeGreaterThanOrEqual(N / 2);
    // Every edge routes with finite endpoints.
    expect(view.edgeRoutes).toHaveLength(N - 1 + cross.length);
    expect(view.edgeRoutes.every((r) => r.points.every((p) => finite(p.x) && finite(p.y)))).toBe(true);
    expect(view.diagnostics).toMatchObject({ nodeCount: N, edgeCount: N - 1 + cross.length });
  });

  it('tolerates a malformed projection structurally (fail-closed → empty view, never throws)', () => {
    expect(buildKnowledgeGraphView(undefined).frames).toEqual([]);
    expect(buildKnowledgeGraphView({ nodes: 'x' }).frames).toEqual([]);
  });
});
