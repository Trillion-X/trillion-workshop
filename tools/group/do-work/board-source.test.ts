// parts/group/do-work/board-source.test.ts
//
// Any records drawn on the board and kept in step with their source (board-source.ts): placed once, laid out in
// layers, words and state following the record, the person's own items and moves never touched, framed by group
// when there are more than a handful, and card edits handed back.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, patchItems, placeItem, placeItems, readItems, removeItems } from '../read-data/group-board-model';
import { planBoardSource, sourceEdits, sourceMarkOf, sourcePortsOf, type BoardSource } from './board-source';

const B = boardRootRef('b');
const LAYOUT = { origin: { x: 0, y: 0 }, card: { w: 200, h: 100 }, gap: { x: 80, y: 40 }, most: 12, framePadding: 32 };
const apply = (graph: ReturnType<typeof emptyGraph>, source: BoardSource) => {
  const plan = planBoardSource(readItems(graph, B), source, 'b', LAYOUT);
  return { plan, graph: removeItems(patchItems(placeItems(graph, B, plan.place), B, plan.patch), B, plan.remove) };
};
const chain: BoardSource = {
  key: 'w',
  cards: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second', state: { label: 'Working', tone: 'info' } }, { id: 'c', text: 'Third' }],
  lines: [{ from: 'a', to: 'b', label: 'words' }, { from: 'b', to: 'c' }],
};

describe('planBoardSource', () => {
  it('places one card per record and one labelled connector per line, in layers left to right', () => {
    const { graph } = apply(emptyGraph(), chain);
    const items = readItems(graph, B);
    const cards = items.filter(item => sourceMarkOf(item)?.role === 'card');
    expect(cards.map(card => card.text)).toEqual(['First', 'Second', 'Third']);
    expect(cards.map(card => card.x)).toEqual([0, 280, 560]);
    const lines = items.filter(item => sourceMarkOf(item)?.role === 'line');
    expect(lines).toHaveLength(2);
    expect(lines[0].extra.label).toBe('words');
    expect(cards[1].extra.sourceState).toEqual({ label: 'Working', tone: 'info' });
  });

  it('gives each kind of line its own coloured port on both cards, and lines of one kind share it', () => {
    const typed: BoardSource = {
      key: 't',
      cards: [{ id: 'a', text: 'Find' }, { id: 'b', text: 'Write' }],
      lines: [{ from: 'a', to: 'b', label: 'leads', kind: 'list' }, { from: 'a', to: 'b', label: 'note', kind: 'words' }],
    };
    const layout = { ...LAYOUT, kinds: { words: '#111111' }, palette: ['#222222'], routing: 'curved' };
    const plan = planBoardSource([], typed, 'b', layout);
    const lines = plan.place.filter(item => item.kind === 'connector');
    expect(lines.map(line => [line.extra?.color, line.extra?.routing, line.extra?.lineKind])).toEqual([['#222222', 'curved', 'list'], ['#111111', 'curved', 'words']]);
    expect(lines.map(line => line.extra?.fromAnchor)).toEqual([{ nx: 1, ny: 1 / 3 }, { nx: 1, ny: 2 / 3 }]);
    expect(lines.map(line => line.extra?.toAnchor)).toEqual([{ nx: 0, ny: 1 / 3 }, { nx: 0, ny: 2 / 3 }]);
    const graph = placeItems(emptyGraph(), B, plan.place);
    const [find, write] = readItems(graph, B).filter(item => sourceMarkOf(item)?.role === 'card');
    expect(sourcePortsOf(find)).toEqual([{ side: 'right', at: 1 / 3, color: '#222222', title: 'list' }, { side: 'right', at: 2 / 3, color: '#111111', title: 'words' }]);
    expect(sourcePortsOf(write).map(port => port.side)).toEqual(['left', 'left']);
    expect(planBoardSource(readItems(graph, B), typed, 'b', layout)).toEqual({ place: [], patch: [], remove: [] });
  });

  it('puts a record the person just added centred where they asked for it', () => {
    const plan = planBoardSource([], chain, 'b', LAYOUT, new Map([['b', { x: 1000, y: 500 }]]));
    const second = plan.place.find(item => sourceMarkOf({ ...item, extra: item.extra ?? {} } as never)?.id === 'b' && item.kind === 'note');
    expect([second?.x, second?.y]).toEqual([900, 450]);
  });

  it('plans nothing when the same source is read again', () => {
    const { graph } = apply(emptyGraph(), chain);
    const again = planBoardSource(readItems(graph, B), chain, 'b', LAYOUT);
    expect(again).toEqual({ place: [], patch: [], remove: [] });
  });

  it('follows words and state, keeps where the person moved a card, and removes what the source dropped', () => {
    let { graph } = apply(emptyGraph(), chain);
    const second = readItems(graph, B).find(item => item.text === 'Second')!;
    graph = patchItems(graph, B, [{ memberId: second.memberId, patch: { x: 999, y: 777 } }]);
    graph = apply(graph, { key: 'w', cards: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second, renamed', state: { label: 'Done', tone: 'success' } }], lines: [{ from: 'a', to: 'b', label: 'words' }] }).graph;
    const items = readItems(graph, B);
    const moved = items.find(item => item.memberId === second.memberId)!;
    expect([moved.x, moved.y, moved.text]).toEqual([999, 777, 'Second, renamed']);
    expect(moved.extra.sourceState).toEqual({ label: 'Done', tone: 'success' });
    expect(items.some(item => item.text === 'Third')).toBe(false);
    expect(items.filter(item => sourceMarkOf(item)?.role === 'line')).toHaveLength(1);
  });

  it('never touches what the person drew, and places new cards below it', () => {
    let graph = placeItem(emptyGraph(), B, { memberId: 'mine', nodeRef: itemRef('b', 'mine'), kind: 'note', x: 0, y: 0, w: 300, h: 300, text: 'my note' });
    graph = apply(graph, chain).graph;
    graph = apply(graph, { key: 'w', cards: [], lines: [] }).graph;
    const items = readItems(graph, B);
    expect(items.map(item => item.memberId)).toEqual(['mine']);
    const placed = planBoardSource(readItems(graph, B), chain, 'b', LAYOUT).place.filter(item => item.kind === 'note');
    expect(Math.min(...placed.map(item => item.y))).toBeGreaterThan(300);
  });

  it('puts more than a handful into one frame per group', () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, text: `Step ${i}`, group: ['Trigger', 'Schedule', 'Workflow'][i % 3] }));
    const { plan } = apply(emptyGraph(), { key: 'many', cards, lines: [] });
    const frames = plan.place.filter(item => item.kind === 'frame');
    expect(frames.map(frame => frame.text)).toEqual(['Trigger', 'Schedule', 'Workflow']);
    for (const frame of frames) {
      const inside = plan.place.filter(item => item.kind === 'note' && item.x >= frame.x && item.y >= frame.y && item.x + 200 <= frame.x + frame.w! && item.y + 100 <= frame.y + frame.h!);
      expect(inside).toHaveLength(10);
    }
  });
});

describe('sourceEdits', () => {
  it('hands back a source card whose words the person changed, and nothing else', () => {
    const { graph } = apply(emptyGraph(), chain);
    const before = readItems(graph, B);
    const first = before.find(item => item.text === 'First')!;
    const after = readItems(patchItems(graph, B, [{ memberId: first.memberId, patch: { text: 'First, better' } }]), B);
    expect(sourceEdits(before, after, 'w')).toEqual([{ id: 'a', text: 'First, better' }]);
    expect(sourceEdits(before, after, 'other')).toEqual([]);
  });
});

describe('toggleFrameFold', () => {
  it('folds a frame to its name with what is inside hidden, and opens it back exactly as it was', async () => {
    const { toggleFrameFold } = await import('./board-frames');
    const cards = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, text: `Step ${i}`, group: ['Trigger', 'Schedule', 'Workflow'][i % 3] }));
    let graph = apply(emptyGraph(), { key: 'many', cards, lines: [] }).graph;
    const frame = readItems(graph, B).find(item => item.kind === 'frame' && item.text === 'Trigger')!;
    const mine = readItems(graph, B).find(item => item.text === 'Step 0')!;
    graph = patchItems(graph, B, [{ memberId: mine.memberId, patch: { hidden: true } }]);
    graph = toggleFrameFold(graph, B, [frame.memberId], 56);
    const folded = readItems(graph, B);
    expect(folded.find(item => item.memberId === frame.memberId)!.h).toBe(56);
    expect(folded.filter(item => item.extra.foldedBy === frame.memberId)).toHaveLength(9);
    graph = toggleFrameFold(graph, B, [frame.memberId], 56);
    const open = readItems(graph, B);
    expect(open.find(item => item.memberId === frame.memberId)!.h).toBe(frame.h);
    expect(open.filter(item => item.extra.hidden === true).map(item => item.text)).toEqual(['Step 0']);
  });
});
