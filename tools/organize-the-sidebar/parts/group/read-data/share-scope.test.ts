// packages/group/read-data/share-scope.test.ts
//
// Pins the share-scope resolver's contract: the core dispatcher is blind to the scope
// kind (L090). Built-in kinds (board/selection/section/tag) resolve deterministically in
// items order; an unknown kind returns []; and a caller can add a brand-new kind purely
// by injecting a resolver map — proving the dispatcher never enumerates what it handles.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  DEFAULT_SCOPE_RESOLVERS,
  resolveShareScope,
  type ScopeItem,
  type ScopeResolver,
} from '../../../read-data/share-scope.ts';

const items: readonly ScopeItem[] = [
  { memberId: 'a', sectionId: 's1', tags: ['red', 'star'] },
  { memberId: 'b', sectionId: 's1', tags: ['blue'] },
  { memberId: 'c', sectionId: 's2', tags: ['red'] },
  { memberId: 'd', sectionId: 's2' },
];

describe('resolveShareScope — enum-dissolved share coverage', () => {
  it('(1) board → every member id, in items order', () => {
    expect(resolveShareScope(items, { kind: 'board' })).toEqual(['a', 'b', 'c', 'd']);
  });

  it('(2) selection → only selected that exist, in items order', () => {
    // 'z' does not exist; selection given out of order — output follows items order.
    expect(
      resolveShareScope(items, { kind: 'selection', selectedIds: ['c', 'a', 'z'] }),
    ).toEqual(['a', 'c']);
  });

  it('(3) section → only items whose sectionId matches', () => {
    expect(resolveShareScope(items, { kind: 'section', sectionId: 's2' })).toEqual([
      'c',
      'd',
    ]);
  });

  it('(4) tag → only items whose tags include the tag', () => {
    expect(resolveShareScope(items, { kind: 'tag', tag: 'red' })).toEqual(['a', 'c']);
  });

  it('(5) unknown kind → [] (never throws)', () => {
    expect(resolveShareScope(items, { kind: 'nope' })).toEqual([]);
  });

  it('(6) a CUSTOM injected resolver adds a brand-new kind with ZERO change to resolveShareScope', () => {
    // A kind the core never heard of: "even-index" members. Proves L090 — the dispatcher
    // does not enumerate kinds; behavior is injected data.
    const everyOther: ScopeResolver = (list) =>
      list.filter((_, i) => i % 2 === 0).map((it) => it.memberId);
    const resolvers = { ...DEFAULT_SCOPE_RESOLVERS, 'even-index': everyOther };
    expect(resolveShareScope(items, { kind: 'even-index' }, resolvers)).toEqual([
      'a',
      'c',
    ]);
    // And the default map still knows nothing about it.
    expect(resolveShareScope(items, { kind: 'even-index' })).toEqual([]);
  });

  it('(7) empty items → [] for every built-in kind', () => {
    for (const kind of Object.keys(DEFAULT_SCOPE_RESOLVERS)) {
      expect(
        resolveShareScope([], { kind, selectedIds: ['a'], sectionId: 's1', tag: 'red' }),
      ).toEqual([]);
    }
  });

  it('dedups repeated member ids in a scope, preserving first-seen order', () => {
    const dupes: readonly ScopeItem[] = [
      { memberId: 'x', tags: ['t'] },
      { memberId: 'x', tags: ['t'] },
      { memberId: 'y', tags: ['t'] },
    ];
    expect(resolveShareScope(dupes, { kind: 'tag', tag: 't' })).toEqual(['x', 'y']);
  });

  it('section/type/tag with a MISSING target resolve to [] — never match un-set fields (Codex F2)', () => {
    const mixed: readonly ScopeItem[] = [
      { memberId: 'a', sectionId: 's1', itemKind: 'note', tags: ['red'] },
      { memberId: 'b' }, // no section, no kind, no tags — an `=== undefined` match would grab this
      { memberId: 'c', sectionId: 's1', itemKind: 'note' },
    ];
    // A section/type/tag request with no target = unconfigured → empty, NOT "every un-set item".
    expect(resolveShareScope(mixed, { kind: 'section' })).toEqual([]);
    expect(resolveShareScope(mixed, { kind: 'type' })).toEqual([]);
    expect(resolveShareScope(mixed, { kind: 'tag' })).toEqual([]);
    // With a target, the scope resolves correctly (and never includes the un-set item 'b').
    expect(resolveShareScope(mixed, { kind: 'section', sectionId: 's1' })).toEqual(['a', 'c']);
    expect(resolveShareScope(mixed, { kind: 'type', itemKind: 'note' })).toEqual(['a', 'c']);
  });

  it('FAIL-CLOSED on a malformed request/item — never throws (Codex #5)', () => {
    const items: readonly ScopeItem[] = [
      { memberId: 'a', tags: ['red'] },
      { memberId: 'b', tags: 7 as unknown as string[] }, // hostile/legacy: tags not an array
      { memberId: 'c' },
    ];
    // selection with a non-array selectedIds must NOT throw (`new Set(7)` would) → empty selection.
    expect(() => resolveShareScope(items, { kind: 'selection', selectedIds: 7 as unknown as string[] })).not.toThrow();
    expect(resolveShareScope(items, { kind: 'selection', selectedIds: 7 as unknown as string[] })).toEqual([]);
    // tag scope with a non-array item.tags must NOT throw (`(7).includes` would) → just skip 'b'.
    expect(() => resolveShareScope(items, { kind: 'tag', tag: 'red' })).not.toThrow();
    expect(resolveShareScope(items, { kind: 'tag', tag: 'red' })).toEqual(['a']);
  });
});

describe('prototype-key safety — a hostile scope kind never crashes or leaks a wrong shape (cont.98 batch-13)', () => {
  const protoItems: ScopeItem[] = [{ memberId: 'a' }, { memberId: 'b' }];
  it("'__proto__'/'constructor'/'toString'/'hasOwnProperty' resolve to [] (not Object.prototype, not the raw items array)", () => {
    expect(resolveShareScope(protoItems, { kind: '__proto__' })).toEqual([]);
    expect(resolveShareScope(protoItems, { kind: 'constructor' })).toEqual([]); // Object(items) would leak the array
    expect(resolveShareScope(protoItems, { kind: 'toString' })).toEqual([]);
    expect(resolveShareScope(protoItems, { kind: 'hasOwnProperty' })).toEqual([]);
    expect(() => resolveShareScope(protoItems, { kind: '__proto__' })).not.toThrow();
  });
  it('a real kind still resolves (zero regression)', () => {
    expect(resolveShareScope(protoItems, { kind: 'board' })).toEqual(['a', 'b']);
  });
});
