// packages/group/do-work/board-opml.test.ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { boardToOpml } from './board-opml';
import type { BoardItem } from '../read-data/group-board-model';

// Cards carry a position (mindMapOutline orders siblings by y then x) + text (first line is the outline row).
const card = (memberId: string, text: string, x = 0, y = 0): BoardItem =>
  ({ kind: 'note', memberId, x, y, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

// root → two children (child1 above child2), child1 → grandchild.
const tree = (): BoardItem[] => [
  card('root', 'Root', 0, 0),
  card('c1', 'Child One', 0, 100),
  card('c2', 'Child Two', 0, 200),
  card('g1', 'Grandchild', 0, 300),
  conn('e1', 'root', 'c1'), conn('e2', 'root', 'c2'), conn('e3', 'c1', 'g1'),
];

describe('boardToOpml', () => {
  it('emits a well-formed OPML 2.0 document (parses as XML, no parser error)', () => {
    const xml = boardToOpml(tree(), 'My Map');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.tagName).toBe('opml');
    expect(doc.documentElement.getAttribute('version')).toBe('2.0');
    expect(doc.querySelector('head > title')!.textContent).toBe('My Map');
  });

  it('nests children under their parent (root > c1 > g1, root > c2)', () => {
    const doc = new DOMParser().parseFromString(boardToOpml(tree()), 'application/xml');
    const body = doc.querySelector('body')!;
    const roots = [...body.children];
    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute('text')).toBe('Root');
    const kids = [...roots[0].children];
    expect(kids.map((k) => k.getAttribute('text'))).toEqual(['Child One', 'Child Two']); // visual order (y)
    // Child One has the grandchild nested; Child Two is a leaf.
    expect([...kids[0].children].map((k) => k.getAttribute('text'))).toEqual(['Grandchild']);
    expect([...kids[1].children]).toHaveLength(0);
  });

  it('an isolated card (no connectors) is a top-level outline', () => {
    const doc = new DOMParser().parseFromString(boardToOpml([card('solo', 'Alone')]), 'application/xml');
    const roots = [...doc.querySelector('body')!.children];
    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute('text')).toBe('Alone');
    expect([...roots[0].children]).toHaveLength(0);
  });

  it('XML-escapes card text so it cannot break the document', () => {
    const doc = new DOMParser().parseFromString(boardToOpml([card('x', 'A & B <tag> "q"')]), 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect([...doc.querySelector('body')!.children][0].getAttribute('text')).toBe('A & B <tag> "q"');
  });

  it('an empty board yields a valid document with an empty body', () => {
    const xml = boardToOpml([]);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect([...doc.querySelector('body')!.children]).toHaveLength(0);
    expect(doc.querySelector('head > title')!.textContent).toBe('Board'); // default title
  });
});
