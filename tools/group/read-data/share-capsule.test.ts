// packages/group/read-data/share-capsule.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildShareCapsule,
  capsuleSummary,
  decodeCapsuleText,
  encodeCapsuleText,
  isShareCapsule,
  type CapsuleSource,
  type CapsuleSourceItem,
} from './share-capsule';

const item = (
  memberId: string,
  over: Partial<CapsuleSourceItem> = {},
): CapsuleSourceItem => ({
  memberId,
  kind: 'note',
  x: 0,
  y: 0,
  w: 200,
  h: 80,
  text: memberId,
  ...over,
});

const board = (
  boardId: string,
  title: string,
  items: readonly CapsuleSourceItem[],
  scope: CapsuleSource['scope'] = { kind: 'board' },
): CapsuleSource => ({ boardId, title, items, scope });

describe('buildShareCapsule — scope carving', () => {
  it('board scope keeps every item, in order', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Ideas', [item('a'), item('b'), item('c')])],
      'Ideas',
    );
    expect(cap.boards).toHaveLength(1);
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'b', 'c']);
  });

  it('selection scope keeps only selected ids', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Ideas', [item('a'), item('b'), item('c')], { kind: 'selection', selectedIds: ['a', 'c'] })],
      'Picks',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'c']);
  });

  it('a directly-selected connector is DROPPED when its endpoints are not both kept (no dangling edge exported)', () => {
    const conn = item('e', { extra: { fromMemberId: 'a', toMemberId: 'b' } });
    // select ONLY the connector 'e' — its endpoints a/b are not selected, so it must not export a line to nothing
    const cap = buildShareCapsule(
      [board('b1', 'Ideas', [item('a'), item('b'), conn], { kind: 'selection', selectedIds: ['e'] })],
      'Danglers',
    );
    // the whole board scopes to an empty content set -> dropped board (no dangling connector shipped)
    expect(cap.boards).toHaveLength(0);
    // but selecting the connector WITH both endpoints keeps all three
    const cap2 = buildShareCapsule(
      [board('b1', 'Ideas', [item('a'), item('b'), conn], { kind: 'selection', selectedIds: ['a', 'b', 'e'] })],
      'Linked',
    );
    expect(cap2.boards[0].items.map((i) => i.memberId).sort()).toEqual(['a', 'b', 'e']);
  });

  it('section scope keeps only the section members', () => {
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Ideas',
          [item('a', { sectionId: 's1' }), item('b', { sectionId: 's2' }), item('c', { sectionId: 's1' })],
          { kind: 'section', sectionId: 's1' },
        ),
      ],
      'Section',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'c']);
  });

  it('section CLOSURE: selecting a section carries its whole subtree (nested content, not an empty folder)', () => {
    // A section 'sec' with two children + a nested section 'sec2' holding a grandchild. Selecting
    // ONLY the section 'sec' must pull in c1/c2/sec2/g1 (transitive) — "share the section" = its contents.
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Doc',
          [
            item('top'),
            item('sec', { isSection: true, childCount: 3 }),
            item('c1', { sectionId: 'sec' }),
            item('c2', { sectionId: 'sec' }),
            item('sec2', { isSection: true, childCount: 1, sectionId: 'sec' }),
            item('g1', { sectionId: 'sec2' }),
          ],
          { kind: 'selection', selectedIds: ['sec'] },
        ),
      ],
      'Doc',
    );
    // the section + its full subtree come along; the unrelated 'top' item does not
    expect(cap.boards[0].items.map((i) => i.memberId).sort()).toEqual(['c1', 'c2', 'g1', 'sec', 'sec2']);
  });

  it('board scope carries a section AND its children (section metadata survives)', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Doc', [item('sec', { isSection: true, childCount: 2 }), item('c1', { sectionId: 'sec' }), item('c2', { sectionId: 'sec' })])],
      'Doc',
    );
    const sec = cap.boards[0].items.find((i) => i.memberId === 'sec')!;
    expect(sec.isSection).toBe(true);
    expect(sec.childCount).toBe(2);
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['sec', 'c1', 'c2']);
  });

  it('tag scope keeps only tagged items', () => {
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Ideas',
          [item('a', { tags: ['hot'] }), item('b', { tags: ['cold'] }), item('c', { tags: ['hot', 'new'] })],
          { kind: 'tag', tag: 'hot' },
        ),
      ],
      'Hot',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'c']);
  });

  it('type scope shares "a certain type of thing" (item kind)', () => {
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Mixed',
          [item('a', { itemKind: 'link' }), item('b', { itemKind: 'note' }), item('c', { itemKind: 'link' })],
          { kind: 'type', itemKind: 'link' },
        ),
      ],
      'Links only',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'c']);
  });

  it('type scope derives from the item kind alone (no redundant itemKind needed)', () => {
    // items carry only `kind` — buildShareCapsule surfaces it as itemKind for the scope.
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Mixed',
          [item('a', { kind: 'link' }), item('b', { kind: 'note' }), item('c', { kind: 'link' })],
          { kind: 'type', itemKind: 'link' },
        ),
      ],
      'Links',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'c']);
  });

  it('connector closure: a subset scope keeps connectors between two kept nodes', () => {
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Graph',
          [
            item('a'),
            item('b'),
            item('c'),
            item('e-ab', { extra: { fromMemberId: 'a', toMemberId: 'b', relationKind: 'depends-on' } }),
            item('e-bc', { extra: { fromMemberId: 'b', toMemberId: 'c' } }),
          ],
          { kind: 'selection', selectedIds: ['a', 'b'] },
        ),
      ],
      'Picks',
    );
    // a, b kept; e-ab (a→b, both kept) comes along; e-bc (b→c, c NOT kept) is dropped
    expect(cap.boards[0].items.map((i) => i.memberId).sort()).toEqual(['a', 'b', 'e-ab']);
  });

  it('carries the board background id into the capsule (opener fidelity)', () => {
    const src = { ...board('b1', 'Blue', [item('a')]), background: 'blueprint' };
    const cap = buildShareCapsule([src], 'Blue');
    expect(cap.boards[0].background).toBe('blueprint');
    // no background → the field is simply absent (not null)
    expect('background' in buildShareCapsule([board('b2', 'Plain', [item('a')])], 'Plain').boards[0]).toBe(false);
  });

  it('connector closure does not add a node — board scope is unchanged', () => {
    const cap = buildShareCapsule(
      [board('b1', 'All', [item('a'), item('b'), item('e', { extra: { fromMemberId: 'a', toMemberId: 'b' } })])],
      'All',
    );
    expect(cap.boards[0].items.map((i) => i.memberId).sort()).toEqual(['a', 'b', 'e']);
  });

  it('drops boards that end up empty after scoping', () => {
    const cap = buildShareCapsule(
      [
        board('b1', 'A', [item('a', { tags: ['x'] })], { kind: 'tag', tag: 'missing' }),
        board('b2', 'B', [item('b')]),
      ],
      'Mix',
    );
    expect(cap.boards.map((b) => b.boardId)).toEqual(['b2']);
  });
});

describe('buildShareCapsule — multi-board (several boards, one link)', () => {
  it('carries N boards in a single capsule', () => {
    const cap = buildShareCapsule(
      [
        board('b1', 'Plan', [item('a'), item('b')]),
        board('b2', 'Notes', [item('c')]),
        board('b3', 'Refs', [item('d'), item('e')]),
      ],
      'My workspace',
    );
    expect(cap.boards.map((b) => b.boardId)).toEqual(['b1', 'b2', 'b3']);
    expect(capsuleSummary(cap)).toBe('5 items across 3 boards');
  });

  it('per-board scopes apply independently within one capsule', () => {
    const cap = buildShareCapsule(
      [
        board('b1', 'All', [item('a'), item('b')]),
        board('b2', 'Sel', [item('c'), item('d')], { kind: 'selection', selectedIds: ['d'] }),
      ],
      'Mixed scopes',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a', 'b']);
    expect(cap.boards[1].items.map((i) => i.memberId)).toEqual(['d']);
  });
});

describe('text codec — self-contained round-trip', () => {
  it('packages shared bodies once across boards while keeping each placement', () => {
    const body = { text: 'Shared content '.repeat(80), html: '<p>Shared content</p>', extra: { tag: 'same' } };
    const cap = buildShareCapsule([
      board('a', 'First', [item('one', body), item('two', { ...body, x: 300 })]),
      board('b', 'Second', [item('three', body)]),
    ], 'Shared');
    const link = encodeCapsuleText(cap);
    const wire = JSON.parse(link);
    expect(wire.format).toBe('group-shared-content-references');
    expect(isShareCapsule(wire)).toBe(false); // Old readers must refuse, not show blank cards.
    expect(wire.contents).toHaveLength(1);
    expect(wire.boards.flatMap((b: any) => b.items).map((i: any) => i.contentRef)).toEqual([0, 0, 0]);
    expect(wire.boards[0].items[0]).not.toHaveProperty('text');
    expect(wire.boards[0].items[0]).not.toHaveProperty('extra');
    expect(decodeCapsuleText(link)).toEqual(cap);
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(cap).length);
    const decoded = decodeCapsuleText(link)!;
    (decoded.boards[0].items[0].extra as Record<string, unknown>).tag = 'edited';
    expect(decoded.boards[0].items[1].extra?.tag).toBe('same');
  });

  it('still opens an inline-body text', () => {
    const cap = buildShareCapsule([board('a', 'Old link', [item('one')])], 'Old');
    expect(decodeCapsuleText(JSON.stringify(cap))).toEqual(cap);
  });

  it('never packages excluded content and rejects dangling or ambiguous references', () => {
    const cap = buildShareCapsule([board('a', 'Pick', [item('one'), item('private', { text: 'EXCLUDED' })], { kind: 'selection', selectedIds: ['one'] })], 'Pick');
    const link = encodeCapsuleText(cap);
    expect(link).not.toContain('EXCLUDED');
    const original = JSON.parse(link);
    const encode = (wire: unknown) => JSON.stringify(wire);
    for (const ref of [-1, 0.5, 1, '0', null]) {
      const wire = structuredClone(original);
      wire.boards[0].items[0].contentRef = ref;
      expect(decodeCapsuleText(encode(wire))).toBeNull();
    }
    const inline = structuredClone(original);
    inline.boards[0].items[0].text = 'competing body';
    expect(decodeCapsuleText(encode(inline))).toBeNull();
    const unused = structuredClone(original);
    unused.contents.push({ text: 'EXCLUDED' });
    expect(decodeCapsuleText(encode(unused))).toBeNull();
    const identity = structuredClone(original);
    identity.contents[0].memberId = 'different';
    expect(decodeCapsuleText(encode(identity))).toBeNull();
  });

  it('bounds expanded reference size before rendering', () => {
    const wire = {
      format: 'group-shared-content-references', id: 'bounded', name: 'Bounded',
      contents: [{ text: 'x'.repeat(100_000) }],
      boards: [{ boardId: 'a', title: 'A', items: Array.from({ length: 100 }, (_, i) => ({ memberId: String(i), kind: 'note', x: 0, y: 0, w: 1, h: 1, contentRef: 0 })) }],
    };
    expect(decodeCapsuleText(JSON.stringify(wire))).toBeNull();
  });
  it('encodes then decodes to an equal capsule', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Ideas', [item('a', { html: '<b>hi</b>', extra: { marker: 'star' } }), item('b')])],
      'Ideas',
    );
    const link = encodeCapsuleText(cap);
    const back = decodeCapsuleText(link);
    expect(back).toEqual(cap);
  });

  it('strips a live-mount directive (extra.placeableSurface) from an untrusted link — no capability smuggle', () => {
    // A hostile link could carry extra.placeableSurface to mount an arbitrary live package surface in the
    // read-only viewer (SP7). decodeCapsuleText must strip it while keeping the rest of the item as static content.
    const cap = buildShareCapsule(
      [board('b1', 'Ideas', [item('a', { extra: { marker: 'star', placeableSurface: { packageName: 'evil', entryName: 'x' } } })])],
      'Ideas',
    );
    const back = decodeCapsuleText(encodeCapsuleText(cap))!;
    const decodedExtra = back.boards[0].items[0].extra as Record<string, unknown>;
    expect('placeableSurface' in decodedExtra).toBe(false); // the live-mount directive is gone
    expect(decodedExtra.marker).toBe('star'); // benign static extra survives
  });

  it('round-trips unicode content (emoji glyphs, non-latin text)', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Böard 🌈', [item('a', { text: 'café ♥ 日本語', extra: { markerGlyph: '💡' } })])],
      'Unicode',
    );
    const back = decodeCapsuleText(encodeCapsuleText(cap));
    expect(back).toEqual(cap);
  });

  it('returns null (never throws) for junk', () => {
    expect(decodeCapsuleText('https://app.example/board')).toBeNull();
    expect(decodeCapsuleText('%%%not-json%%%')).toBeNull();
    expect(decodeCapsuleText('{"v":2}')).toBeNull();
    expect(isShareCapsule({ v: 1, id: 'x', name: 'n', boards: 'nope' })).toBe(false);
  });
});

describe('deterministic id (idempotent shares)', () => {
  it('same scoped content → same id (regardless of extra key order)', () => {
    const a = buildShareCapsule(
      [board('b1', 'I', [item('a', { extra: { p: 1, q: 2 } })])],
      'I',
    );
    const b = buildShareCapsule(
      [board('b1', 'I', [item('a', { extra: { q: 2, p: 1 } })])],
      'I',
    );
    expect(a.id).toBe(b.id);
  });

  it('different content → different id', () => {
    const a = buildShareCapsule([board('b1', 'I', [item('a')])], 'I');
    const b = buildShareCapsule([board('b1', 'I', [item('a'), item('b')])], 'I');
    expect(a.id).not.toBe(b.id);
  });

  it('an explicit-undefined extra key does NOT change the id (hash matches the encoded JSON — Codex #4)', () => {
    // encodeCapsuleText serializes with native JSON.stringify (drops undefined props); the id hash
    // must agree, else these two encode to the SAME link but carry different ids.
    const a = buildShareCapsule([board('b1', 'I', [item('a', { extra: { p: 1 } })])], 'I');
    const b = buildShareCapsule([board('b1', 'I', [item('a', { extra: { p: 1, q: undefined } })])], 'I');
    expect(a.id).toBe(b.id);
    // and the two links are byte-identical (same content → same link)
    expect(encodeCapsuleText(a)).toBe(encodeCapsuleText(b));
  });
});


describe('isShareCapsule — untrusted ITEM validation (a share link is untrusted input; fail-closed)', () => {
  // A share link carries the whole capsule; the opener + importer both do item.x/w directly, so a
  // malformed item must make the link decode to null ("not a capsule"), never crash on open/paste.
  const cap = (items: unknown) => ({ v: 1, id: 'x', name: 'n', boards: [{ boardId: 'b', title: 'T', items }] });
  const good = { memberId: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10 };

  it('rejects a capsule with a null / primitive item', () => {
    expect(isShareCapsule(cap([null]))).toBe(false);
    expect(isShareCapsule(cap(['nope']))).toBe(false);
    expect(isShareCapsule(cap([good, 42]))).toBe(false); // one bad item fails the whole capsule
  });

  it('rejects an item with a non-numeric or non-finite coordinate', () => {
    expect(isShareCapsule(cap([{ ...good, x: 'NaN' }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, y: Infinity }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, w: null }]))).toBe(false);
  });

  it('rejects an item missing memberId or kind', () => {
    expect(isShareCapsule(cap([{ kind: 'note', x: 0, y: 0, w: 1, h: 1 }]))).toBe(false);
    expect(isShareCapsule(cap([{ memberId: 'a', x: 0, y: 0, w: 1, h: 1 }]))).toBe(false);
  });

  it('rejects an item whose isSection/childCount is the WRONG TYPE (section folder metadata)', () => {
    expect(isShareCapsule(cap([{ ...good, isSection: 'yes' }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, childCount: 'many' }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, childCount: Infinity }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, isSection: true, childCount: 3 }]))).toBe(true);
  });

  it('rejects an item whose content field is the WRONG TYPE (text/html/src non-string, extra non-object)', () => {
    // A hostile link that smuggles a non-string html/text or a non-object extra is rejected at
    // the gate, so the renderer never receives a wrong-typed value (the html is also sanitized).
    expect(isShareCapsule(cap([{ ...good, text: 123 }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, html: { evil: true } }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, src: 42 }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, extra: 'not-an-object' }]))).toBe(false);
    expect(isShareCapsule(cap([{ ...good, extra: null }]))).toBe(false);
  });

  it('accepts well-formed content fields (string text/html/src, object extra)', () => {
    expect(isShareCapsule(cap([{ ...good, text: 't', html: '<b>b</b>', src: 'https://x', extra: { k: 1 } }]))).toBe(true);
  });

  it('accepts a well-formed item and an empty items array', () => {
    expect(isShareCapsule(cap([good]))).toBe(true);
    expect(isShareCapsule(cap([]))).toBe(true);
  });

  it('decodeCapsuleText returns null for a text carrying a malformed item (no crash on paste)', () => {
    const badText = JSON.stringify(cap([null]));
    expect(decodeCapsuleText(badText)).toBeNull();
  });
});

describe('share capsule preserves goal-intelligence DATA across the round-trip (metric/timeLog/dueDate)', () => {
  // A vision card's progress lives in extra.metric/timeLog/dueDate. Sharing a board must NOT lose it —
  // else a shared vision board opens with zero progress/forecast. The capsule carries `extra` wholesale;
  // this locks that invariant so a future field-picking refactor can't silently drop the goal DATA.
  const goalExtra = {
    metric: { current: 5, target: 10, start: 0 },
    timeLog: [{ startMs: 1_800_000_000_000, durationMs: 3_600_000 }],
    dueDate: 1_800_000_000_000 + 86_400_000,
    rollupSpec: { relationKind: 'contributes-to', childEndpoint: 'from' },
    // Habit consistency (cont.85): a shared board losing habitCadence would revert the recipient's habit to
    // the daily-moralizing behaviour; losing habitLog would drop the streak. Lock both across the boundary.
    habitLog: [1_799_971_200_000, 1_799_971_200_000 - 86_400_000],
    habitCadence: { period: 'week', times: 3 },
  };

  it('board scope: the full goal extra survives build -> encode -> decode byte-identical', () => {
    const cap = buildShareCapsule([board('b1', 'Vision', [item('goal', { extra: goalExtra }), item('plain')])], 'my vision');
    const round = decodeCapsuleText(encodeCapsuleText(cap));
    expect(round).not.toBeNull();
    const goal = round!.boards[0].items.find((i) => i.memberId === 'goal');
    expect(goal?.extra).toEqual(goalExtra); // metric + timeLog + dueDate + rollupSpec + habitLog + habitCadence intact
  });

  it('selection subset scope: a kept goal card keeps its metric DATA', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Vision', [item('goal', { extra: goalExtra }), item('other')], { kind: 'selection', selectedIds: ['goal'] })],
      'one goal',
    );
    const round = decodeCapsuleText(encodeCapsuleText(cap));
    const goal = round!.boards[0].items.find((i) => i.memberId === 'goal');
    expect(goal).toBeDefined();
    expect((goal!.extra as { metric?: unknown }).metric).toEqual(goalExtra.metric);
  });
});

describe('fail-closed on a corrupt board — duplicate memberIds cannot over-share a subset scope (cont.98 batch-14)', () => {
  it('a SUBSET scope of a board with duplicate cross-section memberIds shares NOTHING (no leak)', () => {
    // Two DISTINCT items share the group-local id 'x' across sections s1/s2 (only possible from a
    // crafted/corrupted board — normal minting is board-unique). A section-s1 scope resolves ONE 'x'
    // but the memberId filter would keep BOTH → the s2 'x' leaks. Fail closed: drop the ambiguous board.
    const cap = buildShareCapsule(
      [
        board(
          'b1',
          'Corrupt',
          [item('x', { sectionId: 's1', text: 'in-s1' }), item('x', { sectionId: 's2', text: 'in-s2' })],
          { kind: 'section', sectionId: 's1' },
        ),
      ],
      'Corrupt',
    );
    expect(cap.boards).toHaveLength(0); // id-ambiguous board dropped from a subset share (no over-share)
  });

  it('a whole-BOARD scope of the same corrupt board still shares everything (no subset ambiguity)', () => {
    const cap = buildShareCapsule(
      [board('b1', 'Corrupt', [item('x', { sectionId: 's1' }), item('x', { sectionId: 's2' })], { kind: 'board' })],
      'Corrupt',
    );
    expect(cap.boards).toHaveLength(1);
    expect(cap.boards[0].items).toHaveLength(2); // board scope shares all — no subset ambiguity to fear
  });

  it('a NORMAL board (unique ids) with a subset scope is UNAFFECTED (zero regression)', () => {
    const cap = buildShareCapsule(
      [
        board('b1', 'Ideas', [item('a', { sectionId: 's1' }), item('b', { sectionId: 's2' })], {
          kind: 'section',
          sectionId: 's1',
        }),
      ],
      'Ideas',
    );
    expect(cap.boards[0].items.map((i) => i.memberId)).toEqual(['a']); // only s1's item, exactly as before
  });
});

describe('share-capsule red-team — untrusted decode hardening (cont.98 batch-29)', () => {
  // F1: a text longer than MAX_TEXT_LEN is refused BEFORE JSON.parse (no CPU/memory burn).
  it('rejects an oversized text (>8MB) as not-a-capsule without parsing', () => {
    const huge = 'x'.repeat(8_000_001);
    expect(decodeCapsuleText(huge)).toBeNull();
  });

  // F1: item/board COUNT caps in isShareCapsule fail closed on a flood (a hostile link can't smuggle
  // 100k+ items past validation → withoutLiveMounts never maps them).
  it('isShareCapsule fails closed on too many boards / too many total items', () => {
    const oneItem = { memberId: 'a', kind: 'note', x: 0, y: 0, w: 10, h: 10 };
    const manyBoards = { v: 1, id: 'x', name: 'n', boards: Array.from({ length: 1001 }, (_, i) => ({ boardId: 'b' + i, title: 't', items: [oneItem] })) };
    expect(isShareCapsule(manyBoards)).toBe(false);
    const manyItems = { v: 1, id: 'x', name: 'n', boards: [{ boardId: 'b', title: 't', items: Array.from({ length: 100_001 }, () => oneItem) }] };
    expect(isShareCapsule(manyItems)).toBe(false);
    // a normal small capsule still validates (zero regression)
    expect(isShareCapsule({ v: 1, id: 'x', name: 'n', boards: [{ boardId: 'b', title: 't', items: [oneItem] }] })).toBe(true);
  });

  // F2: a finite-huge coord PASSES isShareCapsule (it IS finite) but is CLAMPED on decode, and a
  // negative dimension is floored — the read-only opener never receives a coord that overflows its math.
  it('clamps a Number.MAX_VALUE coord and floors a negative dimension on decode', () => {
    const cap = buildShareCapsule(
      [board('b', 'T', [item('a', { x: Number.MAX_VALUE, y: -Number.MAX_VALUE, w: Number.MAX_VALUE, h: -50 })])],
      'Hostile',
    );
    const decoded = decodeCapsuleText(encodeCapsuleText(cap));
    expect(decoded).not.toBeNull();
    const it0 = decoded!.boards[0].items[0];
    expect(Math.abs(it0.x)).toBeLessThanOrEqual(1e7);
    expect(Math.abs(it0.y)).toBeLessThanOrEqual(1e7);
    expect(it0.w).toBeGreaterThanOrEqual(0);
    expect(it0.w).toBeLessThanOrEqual(1e7);
    expect(it0.h).toBe(0); // -50 floored to 0 (a negative dimension is never a real item)
  });

  // F3: buildShareCapsule over pathologically deep `extra` (reachable after import→re-share) hashes
  // without stack overflow (stableStringify depth cap), and stays deterministic.
  it('hashes a capsule with deeply-nested extra without overflowing (depth cap, deterministic)', () => {
    // Build the nested object ITERATIVELY — a recursive builder overflows at construction (batch-22 lesson).
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 5000; i++) deep = { child: deep };
    let cap: ReturnType<typeof buildShareCapsule> | undefined;
    expect(() => { cap = buildShareCapsule([board('b', 'T', [item('a', { extra: deep })])], 'Deep'); }).not.toThrow();
    expect(typeof cap!.id).toBe('string');
    const again = buildShareCapsule([board('b', 'T', [item('a', { extra: deep })])], 'Deep');
    expect(again.id).toBe(cap!.id); // same deep content → same link id
  });
});
