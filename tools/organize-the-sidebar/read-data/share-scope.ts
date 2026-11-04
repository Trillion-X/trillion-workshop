// packages/group/read-data/share-scope.ts
//
// Pure resolver for "which board members does a share request cover?". A share can
// scope to the whole board, the current selection, a section/frame, or a tag-filtered
// subset — and tomorrow, some kind that does not exist yet.
//
// Enum-dissolved (L090): the core `resolveShareScope` NEVER branches on the scope kind.
// It looks the kind up in an INJECTED capability map of resolvers and dispatches to
// whichever resolver the data selected. Built-in kinds are provided as DATA in
// DEFAULT_SCOPE_RESOLVERS. Adding a new scope kind = add one entry to the map, ZERO
// change to the dispatcher. An unknown kind resolves to [] (never throws).
//
// Deterministic and pure: every built-in resolver emits member ids in `items` order,
// deduped. No I/O, no domain object knowledge beyond the minimal self-describing shapes.

export interface ScopeItem {
  readonly memberId: string;
  readonly sectionId?: string; // the section/frame this item belongs to (optional)
  readonly tags?: readonly string[]; // item tags (optional)
  readonly itemKind?: string; // the item's own kind ('note' | 'link' | 'media' | …) (optional)
}

export interface ShareScopeRequest {
  readonly kind: string; // 'board' | 'selection' | 'section' | 'tag' | 'type' | (future)
  readonly selectedIds?: readonly string[];
  readonly sectionId?: string;
  readonly tag?: string;
  readonly itemKind?: string; // target item kind for the 'type' scope ("a certain type of thing")
}

export type ScopeResolver = (
  items: readonly ScopeItem[],
  request: ShareScopeRequest,
) => string[];

// Emit member ids in `items` order for the items that pass `keep`, deduped.
const collect = (
  items: readonly ScopeItem[],
  keep: (item: ScopeItem) => boolean,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!keep(item)) continue;
    if (seen.has(item.memberId)) continue;
    seen.add(item.memberId);
    out.push(item.memberId);
  }
  return out;
};

export const DEFAULT_SCOPE_RESOLVERS: Readonly<Record<string, ScopeResolver>> = {
  board: (items) => collect(items, () => true),
  selection: (items, request) => {
    // Fail-closed on a malformed request: a non-array `selectedIds` (e.g. a number) would make
    // `new Set(...)` throw "not iterable" — treat it as an empty selection instead.
    const selected = new Set(Array.isArray(request.selectedIds) ? request.selectedIds : []);
    return collect(items, (item) => selected.has(item.memberId));
  },
  // section/type/tag REQUIRE their target param — without it the scope resolves to NOTHING, never
  // to "every item whose field is also undefined" (a bare `=== undefined` match would silently
  // share ALL un-sectioned / un-typed items). A missing target = an unconfigured request = [].
  section: (items, request) =>
    request.sectionId ? collect(items, (item) => item.sectionId === request.sectionId) : [],
  tag: (items, request) =>
    // Fail-closed on a malformed item: a non-array `item.tags` (e.g. a number) would make
    // `.includes` throw — guard it so one bad item never aborts the whole scope.
    request.tag ? collect(items, (item) => (Array.isArray(item.tags) ? item.tags : []).includes(request.tag as string)) : [],
  type: (items, request) =>
    request.itemKind ? collect(items, (item) => item.itemKind === request.itemKind) : [],
};

export function resolveShareScope(
  items: readonly ScopeItem[],
  request: ShareScopeRequest,
  resolvers: Readonly<Record<string, ScopeResolver>> = DEFAULT_SCOPE_RESOLVERS,
): string[] {
  // Look up ONLY an OWN key — never a prototype-chain member. A hostile request.kind of
  // '__proto__' would resolve to Object.prototype (truthy, not callable) → a crash, and
  // 'constructor'/'hasOwnProperty'/'toString' would resolve to inherited FUNCTIONS that,
  // when called as a resolver, return the raw items array or a bogus string — leaking a
  // wrong shape out of a SHARE (security) path. hasOwn + a function-type check fail closed.
  const resolver = Object.prototype.hasOwnProperty.call(resolvers, request.kind)
    ? resolvers[request.kind]
    : undefined;
  if (typeof resolver !== 'function') return [];
  return resolver(items, request);
}
