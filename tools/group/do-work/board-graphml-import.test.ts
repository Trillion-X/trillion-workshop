// packages/group/do-work/board-graphml-import.test.ts
//
// Proves b171 — GraphML import — three ways: (1) the ROUND-TRIP against the b149 export (boardToGraphml →
// parseGraphml recovers the same node labels + edges); (2) parser edge cases (self-closing tags, attribute
// order, XML-entity un-escaping, malformed → skipped not thrown); (3) graphmlToBoardItems shapes cards +
// connectors like the mermaid importer.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { parseGraphml, looksLikeGraphml, graphmlToBoardItems } from './board-graphml-import';
import { boardToGraphml } from './board-graphml';

function note(memberId: string, text: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text, extra: {}, isSection: false } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string, relationKind?: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) }, isSection: false } as unknown as BoardItem;
}

describe('looksLikeGraphml', () => {
  it('recognizes a graphml root, rejects other text', () => {
    expect(looksLikeGraphml('<?xml version="1.0"?><graphml xmlns="...">')).toBe(true);
    expect(looksLikeGraphml('flowchart TD\n A --> B')).toBe(false);
    expect(looksLikeGraphml('just text')).toBe(false);
    expect(looksLikeGraphml(undefined as unknown as string)).toBe(false);
  });
});

describe('parseGraphml — parser', () => {
  it('parses nodes (label + kind) and edges (source/target/relation)', () => {
    const xml = `<graphml><graph edgedefault="directed">
      <node id="n0"><data key="label">Alpha</data><data key="kind">note</data></node>
      <node id="n1"><data key="label">Beta</data></node>
      <edge id="e0" source="n0" target="n1"><data key="relation">blocks</data></edge>
    </graph></graphml>`;
    const g = parseGraphml(xml);
    expect(g.nodes).toEqual([{ id: 'n0', label: 'Alpha', kind: 'note' }, { id: 'n1', label: 'Beta' }]);
    expect(g.edges).toEqual([{ from: 'n0', to: 'n1', relation: 'blocks' }]);
  });

  it('tolerates self-closing nodes/edges + attribute order; a node w/o label falls back to its id', () => {
    const xml = `<graphml><node id="a"/><node id="b"><data key="label">Bee</data></node>` +
      `<edge target="b" source="a" id="e0"/></graphml>`;
    const g = parseGraphml(xml);
    expect(g.nodes).toEqual([{ id: 'a', label: 'a' }, { id: 'b', label: 'Bee' }]);
    expect(g.edges).toEqual([{ from: 'a', to: 'b' }]); // no relation data → omitted
  });

  it('un-escapes the five XML entities in labels', () => {
    const xml = `<graphml><node id="n0"><data key="label">A &amp; B &lt;x&gt; &quot;q&quot; &apos;p&apos;</data></node></graphml>`;
    expect(parseGraphml(xml).nodes[0].label).toBe(`A & B <x> "q" 'p'`);
  });

  it('skips malformed nodes/edges (no id / no endpoints), never throws', () => {
    const xml = `<graphml><node>no id</node><node id="ok"/><edge source="ok"/><edge source="ok" target="ok"/></graphml>`;
    const g = parseGraphml(xml);
    expect(g.nodes).toEqual([{ id: 'ok', label: 'ok' }]);
    expect(g.edges).toEqual([{ from: 'ok', to: 'ok' }]); // the edge missing target is dropped
    expect(parseGraphml('')).toEqual({ nodes: [], edges: [] });
  });
});

describe('ROUND-TRIP: boardToGraphml → parseGraphml recovers the graph', () => {
  it('recovers every node label and every edge (by label)', () => {
    const board: BoardItem[] = [
      note('a', 'Launch\nmore text'), // label = first non-empty line
      note('b', 'Marketing'),
      note('c', 'Product'),
      connector('e1', 'a', 'b', 'relates-to'),
      connector('e2', 'a', 'c', 'relates-to'),
    ];
    const xml = boardToGraphml(board);
    expect(looksLikeGraphml(xml)).toBe(true);
    const g = parseGraphml(xml);

    // labels round-trip (export renames memberIds to n0,n1,…; compare by label set)
    expect(new Set(g.nodes.map((n) => n.label))).toEqual(new Set(['Launch', 'Marketing', 'Product']));
    // edges round-trip: map exported n-ids back to labels, compare the label pairs
    const labelOf = new Map(g.nodes.map((n) => [n.id, n.label]));
    const edgeLabels = g.edges.map((e) => `${labelOf.get(e.from)}->${labelOf.get(e.to)}`).sort();
    expect(edgeLabels).toEqual(['Launch->Marketing', 'Launch->Product']);
    // relation attribute survives
    expect(g.edges.every((e) => e.relation === 'relates-to')).toBe(true);
  });

  it('a label with XML-special chars survives the export→import round-trip', () => {
    const board = [note('a', 'A & B <tag>'), note('b', 'plain'), connector('e1', 'a', 'b')];
    const g = parseGraphml(boardToGraphml(board));
    expect(g.nodes.map((n) => n.label).sort()).toEqual(['A & B <tag>', 'plain']);
  });
});

describe('graphmlToBoardItems — board builder', () => {
  const xml = `<graphml>
    <node id="n0"><data key="label">Root</data></node>
    <node id="n1"><data key="label">Child</data></node>
    <edge source="n0" target="n1"><data key="relation">blocks</data></edge>
  </graphml>`;

  it('a card per node (left→right by depth) + a connector per edge', () => {
    const items = graphmlToBoardItems(xml, 40, 40);
    const cards = items.filter((i) => !i.extra?.fromMemberId);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(cards.map((c) => c.text)).toEqual(['Root', 'Child']);
    expect(cards[0].x).toBe(40);              // root at depth 0
    expect(cards[1].x).toBe(40 + 240);        // child at depth 1 (COL_GAP)
    expect(conns).toHaveLength(1);
    expect(conns[0].extra).toMatchObject({ fromMemberId: 'n0', toMemberId: 'n1', relationKind: 'blocks' });
  });

  it('empty / node-less GraphML → no items', () => {
    expect(graphmlToBoardItems('<graphml></graphml>')).toEqual([]);
    expect(graphmlToBoardItems('')).toEqual([]);
  });
});
