// packages/group/do-work/board-subject-bag.test.ts
//
// Proves the subject-projection primitive: ONE generic `subjectBag` engine + injected
// formatters (plainLine / idAnnotatedLine). The id-annotated projection is the board half
// of Flavor B (edit-in-place): it exposes each note's stable memberId so the agent can echo
// it and the reconcile seam edits that note in place. We also prove the round-trip — an
// id-annotated bag's ids are exactly the ids `reconcileOutputFromItems` treats as "edit in
// place" — so the two halves compose.

import { describe, expect, it } from 'vitest';
import {
  memberText,
  plainLine,
  idAnnotatedLine,
  subjectBag,
  selectedSubjectBag,
  DEFAULT_MAX_SUBJECT_CHARS,
  type SubjectMember,
} from './board-subject-bag';
import { reconcileOutputFromItems, producerItemsToReconcileItems } from './reconcile-output-from-items';
import { reconcileBoardGraphAuthoritative } from './reconcile-board-producer';
import { applyProducerOutput } from './apply-producer-output';
import { emptyGraph, membersOf, memberById, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

const m = (memberId: string, text?: string, extra?: SubjectMember['extra'], html?: string): SubjectMember =>
  ({ memberId, text, html, extra });

describe('memberText — the SSOT text extractor', () => {
  it('prefers text, falls back to stripped html, else empty', () => {
    expect(memberText(m('a', 'hello'))).toBe('hello');
    expect(memberText(m('b', undefined, undefined, '<b>bold</b> <i>x</i>'))).toBe('bold x');
    expect(memberText(m('c'))).toBe('');
  });
});

describe('projections — plainLine vs idAnnotatedLine', () => {
  it('plainLine is just the text', () => {
    expect(plainLine(m('n1', 'Learn guitar'))).toBe('Learn guitar');
  });
  it('idAnnotatedLine carries the stable memberId so the agent can echo it', () => {
    expect(idAnnotatedLine(m('n1', 'Learn guitar'))).toBe('[n1] Learn guitar');
  });
  it('idAnnotatedLine yields NO orphan id when the note has no text', () => {
    expect(idAnnotatedLine(m('n1', '   '))).toBe('');
    expect(idAnnotatedLine(m('n2'))).toBe('');
  });
});

describe('subjectBag — the generic engine', () => {
  const board: SubjectMember[] = [
    m('n1', 'Run a 5k'),
    m('n2', 'Read more', { hidden: true }), // off-canvas — must not leak
    m('n3', 'Learn guitar'),
    m('n4', '   '), // empty — dropped
  ];

  it('plain projection: visible, non-empty note text joined, hidden excluded', () => {
    expect(subjectBag(board, plainLine)).toBe('Run a 5k\n\nLearn guitar');
  });

  it('id-annotated projection: every visible note prefixed with its id, hidden excluded', () => {
    expect(subjectBag(board, idAnnotatedLine)).toBe('[n1] Run a 5k\n\n[n3] Learn guitar');
  });

  it('defaults to plainLine when no formatter is given', () => {
    expect(subjectBag(board)).toBe(subjectBag(board, plainLine));
  });

  it('is size-capped so a pathological board cannot blow the prompt', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => m(`h${i}`, 'x'.repeat(100)));
    const out = subjectBag(huge, plainLine, 1000);
    expect(out.length).toBe(1000);
    expect(DEFAULT_MAX_SUBJECT_CHARS).toBe(200_000);
  });
});

describe('selectedSubjectBag — explicit selection never broadens to the whole board', () => {
  const board = [m('private', 'Unselected content'), m('empty', ''), m('hidden', 'Hidden content', { hidden: true }), m('chosen', 'Chosen text')];
  it.each(['empty', 'hidden', 'missing'])('keeps an unusable selection %s empty', id => {
    expect(selectedSubjectBag(board, new Set([id]))).toBe('');
  });
  it('includes only visible selected text and keeps the size cap', () => {
    expect(selectedSubjectBag(board, new Set(['chosen', 'hidden']), 6)).toBe('Chosen');
  });
  it('uses the visible whole board only when no selection exists', () => {
    expect(selectedSubjectBag(board, new Set())).toBe('Unselected content\n\nChosen text');
  });
});

describe('Flavor B round-trip — id-annotated bag ↔ reconcile edit-in-place', () => {
  const board: AddressRef = { family: 'group', parts: { board: 'vision' } };
  const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'vision', item: id } });

  it('the ids the bag exposes are exactly the ids reconcile edits IN PLACE (position kept)', () => {
    // A live board with two positioned notes.
    const before = applyProducerOutput(emptyGraph(), {
      targetGroupRef: board,
      items: [
        { memberId: 'n1', nodeRef: itemRef('n1'), presentation: { kind: 'note', text: 'run', x: 10, y: 10 } },
        { memberId: 'n2', nodeRef: itemRef('n2'), presentation: { kind: 'note', text: 'read', x: 250, y: 10 } },
      ],
    });

    // The board hands the agent an id-annotated subject bag …
    const members: SubjectMember[] = [m('n1', 'run'), m('n2', 'read')];
    const bag = subjectBag(members, idAnnotatedLine);
    expect(bag).toBe('[n1] run\n\n[n2] read');
    // … the ids the agent SEES are the real member ids it must echo.
    const shownIds = [...bag.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]);
    expect(shownIds).toEqual(['n1', 'n2']);

    // The agent edits n1's text (echoing its id), leaves n2, adds a new note (no id).
    const agentItems = [
      { kind: 'note', text: 'Run a 5k without stopping', memberId: 'n1' },
      { kind: 'note', text: 'read', memberId: 'n2' },
      { kind: 'note', text: 'Save 3 months of expenses' },
    ];
    let n = 0;
    const output = reconcileOutputFromItems(
      producerItemsToReconcileItems(agentItems),
      board,
      { x: 500, y: 300 },
      () => `new-${++n}`,
      () => itemRef(`node-${n}`),
    );
    const after = reconcileBoardGraphAuthoritative(before, output);

    // n1 edited IN PLACE — new text, SAME position (the whole point of id echo).
    const p1 = memberById(after, board, 'n1')?.presentation as Record<string, unknown>;
    expect(p1.text).toBe('Run a 5k without stopping');
    expect(p1.x).toBe(10);
    expect(p1.y).toBe(10);
    // n2 kept, new note minted.
    expect(membersOf(after, board).map((x) => x.memberId).sort()).toEqual(['n1', 'n2', 'new-1']);
  });
});
