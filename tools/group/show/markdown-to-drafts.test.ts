// Proof for MARKDOWN IMPORT: headings + bullets become card drafts, nested - [ ]/- [x] tasks become the
// preceding card's checklist (extra.checklist), the trigger is conservative (a plain bullet list is NOT
// markdown -> stays one-note-per-line), and the whole thing ROUND-TRIPS with the b67 export: import a
// card+checklist doc, place it, re-export with boardToMarkdown, and get the same document back.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems, boardRootRef } from '../read-data/group-board-model';
import { materializeItems } from '../read-data/board-template-apply';
import { boardToMarkdown, boardTreeToMarkdown } from '../do-work/board-markdown';
import { markdownToDrafts, markdownToBoardTree, markdownTreeToTemplateItems, looksLikeMarkdown, MAX_MARKDOWN_CARDS } from './markdown-to-drafts';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

describe('markdown-to-drafts — structured Markdown import', () => {
  it('looksLikeMarkdown: true for a heading or a task checkbox; false for plain / plain-bullet lists', () => {
    expect(looksLikeMarkdown('# Plan\n- do it')).toBe(true); // heading
    expect(looksLikeMarkdown('- [ ] task')).toBe(true); // task checkbox
    expect(looksLikeMarkdown('buy milk\nwash car')).toBe(false); // plain lines -> one-note-per-line
    expect(looksLikeMarkdown('- milk\n- eggs')).toBe(false); // plain bullets, no checkbox -> not hijacked
  });

  it('headings and bullets become card drafts', () => {
    const drafts = markdownToDrafts('# Goals\n- Ship it\nJust a line');
    expect(drafts.map((d) => d.text)).toEqual(['Goals', 'Ship it', 'Just a line']);
    expect(drafts.every((d) => d.kind === 'note')).toBe(true);
  });

  it('nested tasks attach to the preceding card as its checklist (done state parsed from [x])', () => {
    const drafts = markdownToDrafts('- Launch\n  - [x] design\n  - [ ] build');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('Launch');
    expect(drafts[0].extra).toEqual({ checklist: [
      { id: 'md-s0', text: 'design', done: true },
      { id: 'md-s1', text: 'build', done: false },
    ] });
  });

  it('a leading task with no card starts its own card', () => {
    const drafts = markdownToDrafts('- [ ] orphan task');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('orphan task');
  });

  it('the card count is capped', () => {
    const many = Array.from({ length: MAX_MARKDOWN_CARDS + 50 }, (_, i) => `- item ${i}`).join('\n');
    // no heading/checkbox here, so add one heading to make it markdown, then it caps the cards
    expect(markdownToDrafts('# Big\n' + many).length).toBe(MAX_MARKDOWN_CARDS);
  });

  it('ROUND-TRIP with b67: import a card+checklist doc, place it, re-export -> same document', () => {
    const doc = '- Launch the app\n  - [x] design\n  - [ ] build\n  - [ ] ship';
    const drafts = markdownToDrafts(doc);
    // place each draft as a real board item (extra spreads into presentation, as layoutDraftsToOutput does)
    let g = emptyGraph();
    drafts.forEach((d, i) => {
      g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: `m${i}` } }, memberId: `m${i}`, x: 0, y: i * 100, w: 100, h: 60, kind: d.kind, text: d.text, extra: d.extra } as never);
    });
    expect(boardToMarkdown(readItems(g, PARENT), 1_760_000_000_000)).toBe(doc);
  });
});

describe('markdown-to-tree — hierarchy-preserving import (sections reconstructed from headings)', () => {
  it('a heading opens a SECTION; its bullets are that section child cards', () => {
    const tree = markdownToBoardTree('## Goals\n- Ship it\n- Tell friends');
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: 'section', text: 'Goals' });
    const sec = tree[0] as Extract<typeof tree[number], { kind: 'section' }>;
    expect(sec.children.map((c) => c.text)).toEqual(['Ship it', 'Tell friends']);
    expect(sec.children.every((c) => c.kind === 'card')).toBe(true);
  });

  it('a deeper heading NESTS a section inside the shallower one; a sibling heading pops back to root', () => {
    const tree = markdownToBoardTree('## Life\n### Health\n- Run a 10k\n## Work\n- Ship v1');
    expect(tree.map((n) => n.text)).toEqual(['Life', 'Work']); // two top-level sections
    const life = tree[0] as Extract<typeof tree[number], { kind: 'section' }>;
    expect(life.children).toHaveLength(1);
    const health = life.children[0] as Extract<typeof tree[number], { kind: 'section' }>;
    expect(health).toMatchObject({ kind: 'section', text: 'Health' });
    expect(health.children.map((c) => c.text)).toEqual(['Run a 10k']); // nested under ### Health
    const work = tree[1] as Extract<typeof tree[number], { kind: 'section' }>;
    expect(work.children.map((c) => c.text)).toEqual(['Ship v1']); // sibling ## popped back to root
  });

  it("a section child card keeps its own checklist from nested - [ ] task lines", () => {
    const tree = markdownToBoardTree('## Launch\n- Build it\n  - [x] design\n  - [ ] code');
    const sec = tree[0] as Extract<typeof tree[number], { kind: 'section' }>;
    const card = sec.children[0] as Extract<typeof tree[number], { kind: 'card' }>;
    expect(card).toMatchObject({ kind: 'card', text: 'Build it' });
    expect(card.steps).toEqual([
      { id: 'md-s0', text: 'design', done: true },
      { id: 'md-s1', text: 'code', done: false },
    ]);
  });

  it('the FLAT import is exactly this tree flattened depth-first (SSOT: one parser, drafts are a fold)', () => {
    const doc = '## Goals\n- Ship it\n### Later\n- Someday';
    const flat = markdownToDrafts(doc).map((d) => d.text);
    // section headings become plain cards, in document order, nesting erased
    expect(flat).toEqual(['Goals', 'Ship it', 'Later', 'Someday']);
  });

  it('total node budget caps sections + cards together', () => {
    const many = Array.from({ length: MAX_MARKDOWN_CARDS + 50 }, (_, i) => `- item ${i}`).join('\n');
    const tree = markdownToBoardTree('## Big\n' + many);
    const sec = tree[0] as Extract<typeof tree[number], { kind: 'section' }>;
    // 1 section + capped cards = MAX total nodes
    expect(1 + sec.children.length).toBe(MAX_MARKDOWN_CARDS);
  });

  it('empty input yields an empty tree (caller falls through to plain paste)', () => {
    expect(markdownToBoardTree('   \n\n  ')).toEqual([]);
  });
});

describe('markdown-tree placement — reuse the shipped materializeItems engine (round-trip with the export)', () => {
  it('a section descriptor frames its children: children sit below the header, card checklist rides extra', () => {
    const items = markdownTreeToTemplateItems(markdownToBoardTree('## Goals\n- Build it\n  - [x] design'), 0, 0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'section', text: 'Goals', x: 0, y: 0 });
    const child = items[0].children![0];
    expect(child).toMatchObject({ kind: 'note', text: 'Build it' });
    expect(child.y).toBeGreaterThanOrEqual(40); // below the section header, inside the frame
    expect(child.extra).toEqual({ checklist: [{ id: 'md-s0', text: 'design', done: true }] });
    // the section frame is at least as wide as its minimum and tall enough to hold the child
    expect(items[0].w).toBeGreaterThanOrEqual(280);
    expect(items[0].h).toBeGreaterThan(child.y);
  });

  it('FULL ROUND-TRIP: markdown -> tree -> placement -> board -> boardTreeToMarkdown reproduces the document', () => {
    // A sectioned outline with a nested section and a checklist — the exact structure the flat import lost.
    const doc = '## Goals\n\n- Ship it\n\n### This year\n\n- Run a 10k\n  - [x] plan\n  - [ ] train\n\n## Health\n\n- Sleep 8h';
    const boardId = 'rt-board';
    const root = boardRootRef(boardId);
    let seq = 0;
    const mint = () => `mint-${seq++}`;
    // import -> place through the SHIPPED engine (no new placement code)
    const g = materializeItems(emptyGraph(), boardId, root, markdownTreeToTemplateItems(markdownToBoardTree(doc)), mint);
    // export the placed board back to markdown — must equal the source (sections + nesting + checklist survive)
    expect(boardTreeToMarkdown(g, root, 1_760_000_000_000)).toBe(doc);
  });

  it('a section-less doc yields NO section descriptors (the paste funnel then uses the flat grid path)', () => {
    const items = markdownTreeToTemplateItems(markdownToBoardTree('- milk\n- [ ] eggs'), 0, 0);
    expect(items.every((i) => i.kind !== 'section')).toBe(true);
  });
});
