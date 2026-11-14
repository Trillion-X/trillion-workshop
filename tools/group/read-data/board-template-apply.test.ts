// packages/group/read-data/board-template-apply.test.ts
//
// Proof of the generic template applier: it stamps any DATA template onto a fresh
// board, nests section children, and remaps connector endpoints to minted ids —
// with ZERO template-specific code (the same fn handles every catalog row).

import { describe, expect, it } from 'vitest';
import { applyTemplate, type BoardTemplate } from './board-template-apply';
import { boardIndexRef, boardRootRef, readBoards, readItems } from './group-board-model';
import { emptyGraph, getGroup, membersOf } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

function mintSeq() {
  let n = 0;
  return () => `m${n++}`;
}

const TEMPLATE: BoardTemplate = {
  id: 'demo',
  name: 'Demo',
  items: [
    { id: 'a', kind: 'note', x: 10, y: 20, w: 200, h: 100, text: 'A' },
    { id: 'b', kind: 'note', x: 300, y: 20, w: 200, h: 100, text: 'B' },
    { id: 'e', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'a', to: 'b' },
    {
      id: 'sec', kind: 'section', x: 0, y: 200, w: 300, h: 200, text: 'Group',
      children: [{ id: 'c', kind: 'note', x: 20, y: 260, w: 150, h: 80, text: 'C' }],
    },
  ],
};

describe('applyTemplate', () => {
  const indexRef = boardIndexRef('idx');

  it('creates the board and places the top-level descriptors at their coords', () => {
    const g = applyTemplate(emptyGraph(), indexRef, { template: TEMPLATE, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    expect(readBoards(g, indexRef).map((b) => b.boardId)).toContain('B1');
    const items = readItems(g, boardRootRef('B1'));
    const a = items.find((i) => i.text === 'A');
    expect(a).toBeTruthy();
    expect({ x: a!.x, y: a!.y, w: a!.w, h: a!.h }).toEqual({ x: 10, y: 20, w: 200, h: 100 });
    // 3 top-level members: note A, note B, connector E, section sec = 4 (C is nested)
    expect(items.length).toBe(4);
  });

  it('remaps the connector endpoints to the minted member ids (not the template-local ids)', () => {
    const g = applyTemplate(emptyGraph(), indexRef, { template: TEMPLATE, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const items = readItems(g, boardRootRef('B1'));
    const a = items.find((i) => i.text === 'A')!;
    const b = items.find((i) => i.text === 'B')!;
    const conn = items.find((i) => typeof i.extra?.fromMemberId === 'string')!;
    expect(conn.extra.fromMemberId).toBe(a.memberId);
    expect(conn.extra.toMemberId).toBe(b.memberId);
    // never dangling at the template-local 'a'/'b'
    expect(conn.extra.fromMemberId).not.toBe('a');
    expect(conn.extra.toMemberId).not.toBe('b');
  });

  it('remaps a connector encoded via extra.fromMemberId/toMemberId (saved-collection shape, Codex F1)', () => {
    // A live board / hand-authored template that carries endpoints on `extra` (not `from`/`to`).
    const T: BoardTemplate = {
      id: 'x', name: 'X',
      items: [
        { id: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'A' },
        { id: 'b', kind: 'note', x: 20, y: 0, w: 10, h: 10, text: 'B' },
        { id: 'c', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } },
      ],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template: T, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const items = readItems(g, boardRootRef('B1'));
    const a = items.find((i) => i.text === 'A')!;
    const conn = items.find((i) => typeof i.extra?.fromMemberId === 'string')!;
    expect(conn.extra.fromMemberId).toBe(a.memberId); // remapped, not the literal 'a'
    expect(conn.extra.fromMemberId).not.toBe('a');
  });

  it('DROPS a connector whose endpoint cannot be remapped (fail-closed, no half-connector, Codex F5)', () => {
    const T: BoardTemplate = {
      id: 'x', name: 'X',
      items: [
        { id: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'A' },
        { id: 'dangling', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'missing', to: 'a' },
      ],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template: T, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const items = readItems(g, boardRootRef('B1'));
    expect(items.map((i) => i.text)).toEqual(['A']); // only the note; the dangling connector is gone
    expect(items.some((i) => i.extra?.toMemberId !== undefined)).toBe(false); // no half-connector placed
  });

  it('nests a section descriptor with its children inside the section group', () => {
    const g = applyTemplate(emptyGraph(), indexRef, { template: TEMPLATE, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const top = readItems(g, boardRootRef('B1'));
    const sec = top.find((i) => i.isSection)!;
    expect(sec.text).toBe('Group');
    expect(getGroup(g, sec.nodeRef)).toBeTruthy();
    const children = readItems(g, sec.nodeRef);
    expect(children.map((c) => c.text)).toEqual(['C']);
  });

  it('does not mutate the source template (pure)', () => {
    const before = JSON.stringify(TEMPLATE);
    applyTemplate(emptyGraph(), indexRef, { template: TEMPLATE, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    expect(JSON.stringify(TEMPLATE)).toBe(before);
  });

  it('applies the template board-level LOOK (background + appearance profile) to the new board', () => {
    const LOOK: BoardTemplate = {
      id: 'look',
      name: 'Look',
      background: 'paper',
      appearance: { connectorStrokeStyle: 'pencil', fontFamily: 'Caveat, cursive' },
      items: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'A' }],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template: LOOK, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const entry = readBoards(g, indexRef).find((b) => b.boardId === 'B1')!;
    expect(entry.background).toBe('paper');
    expect(entry.appearance?.connectorStrokeStyle).toBe('pencil');
    expect(entry.appearance?.fontFamily).toBe('Caveat, cursive');
    // the items still land — the look never displaces content
    expect(readItems(g, boardRootRef('B1')).map((i) => i.text)).toContain('A');
  });

  it('leaves the board at its defaults when the template carries no look (zero regression)', () => {
    const g = applyTemplate(emptyGraph(), indexRef, { template: TEMPLATE, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const entry = readBoards(g, indexRef).find((b) => b.boardId === 'B1')!;
    expect(entry.background).toBeUndefined();
    expect(entry.appearance).toBeUndefined();
  });
});

describe('BOARD_TEMPLATES catalog', () => {
  it('every template applies cleanly (no throw) and yields the expected top-level member count', async () => {
    const { BOARD_TEMPLATES } = await import('../show/board-templates');
    const indexRef = boardIndexRef('idx');
    for (const t of BOARD_TEMPLATES) {
      const g = applyTemplate(emptyGraph(), indexRef, { template: t, newBoardId: `b-${t.id}`, newMemberId: `mem-${t.id}`, mint: mintSeq() });
      const top = membersOf(g, boardRootRef(`b-${t.id}`));
      expect(top.length).toBe(t.items.length);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });
});

describe('applyTemplate — fail-closed on hostile/untrusted descriptors (cont.98 batch-22)', () => {
  const indexRef = boardIndexRef('idx');
  // Built ITERATIVELY — a recursive builder would overflow the stack while CONSTRUCTING the 50k-deep
  // literal (before applyTemplate is even called). This proves the APPLIER (mapIds) fails closed.
  const deep = (n: number): any => {
    let node: any = { id: 'leaf', kind: 'note', x: 0, y: 0, w: 1, h: 1 };
    for (let i = 1; i <= n; i++) node = { id: `s${i}`, kind: 'section', x: 0, y: 0, w: 1, h: 1, children: [node] };
    return node;
  };

  it('#6 a 50000-deep template throws a NAMED nesting error, never a stack overflow', () => {
    // A snapshot artifact\'s producer.input is raw DATA (bypasses collection-store\'s parse) — the applier
    // must guard its own recursion. The named throw is caught by the commit boundary; a RangeError is not safe.
    const template: BoardTemplate = { id: 't', name: 'T', items: [deep(50000)] };
    expect(() => applyTemplate(emptyGraph(), indexRef, { template, newBoardId: 'b', newMemberId: 'board', mint: mintSeq() }))
      .toThrow(/nesting exceeds/);
  });

  it('#7 a duplicate template-local id throws a NAMED error (never a silent wrong-remap or member collision)', () => {
    const template: BoardTemplate = {
      id: 'dup', name: 'Dup',
      items: [
        { id: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'first' },
        { id: 'a', kind: 'note', x: 20, y: 0, w: 10, h: 10, text: 'second' },
      ],
    };
    expect(() => applyTemplate(emptyGraph(), indexRef, { template, newBoardId: 'b', newMemberId: 'board', mint: mintSeq() }))
      .toThrow(/duplicate template-local id/);
  });

  it('#8 a NON-connector note carrying a single stray extra.fromMemberId is PLACED, not deleted', () => {
    // Old OR-condition sent any item with ONE endpoint key into the connector branch and dropped it when
    // the other endpoint was missing — silent content loss. A connector needs BOTH endpoints (isConnectorItem).
    const template: BoardTemplate = {
      id: 't', name: 'T',
      items: [{ id: 'n', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'keep me', extra: { fromMemberId: 'ghost' } }],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const items = readItems(g, boardRootRef('B1'));
    expect(items.map((i) => i.text)).toContain('keep me'); // survives (not dropped)
  });

  it('#8 a genuine BOTH-endpoints connector to a vanished id is still dropped (fail-closed unchanged)', () => {
    const template: BoardTemplate = {
      id: 't', name: 'T',
      items: [
        { id: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'A' },
        { id: 'e', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'a', to: 'missing' },
      ],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const items = readItems(g, boardRootRef('B1'));
    expect(items.map((i) => i.text)).toEqual(['A']); // the dangling connector is dropped, note A stays
  });

  it('#9 a section descriptor whose untrusted extra names core keys can NOT override kind/geometry', () => {
    const template: BoardTemplate = {
      id: 't', name: 'T',
      items: [{
        id: 'sec', kind: 'section', x: 5, y: 7, w: 300, h: 200, text: 'Group',
        children: [{ id: 'c', kind: 'note', x: 20, y: 20, w: 80, h: 40, text: 'inside' }],
        extra: { kind: 'note', x: 999, w: 1, frameBorder: 'solid' }, // hostile core keys + a real styling key
      }],
    };
    const g = applyTemplate(emptyGraph(), indexRef, { template, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    const section = membersOf(g, boardRootRef('B1')).find((m) => (m.presentation as any)?.text === 'Group')!;
    const pres = section.presentation as any;
    expect(pres.kind).toBe('section'); // core wins — NOT flipped to 'note'
    expect(pres.x).toBe(5); // core geometry wins — NOT 999
    expect(pres.w).toBe(300); // NOT 1
    expect(pres.frameBorder).toBe('solid'); // a genuine non-core styling key still survives (no regression)
  });
});
