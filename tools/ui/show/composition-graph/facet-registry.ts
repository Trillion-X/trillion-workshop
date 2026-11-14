// packages/ui/show/composition-graph/facet-registry.ts
//
// The ONE uniform capability-lookup shape (RG-2). Membership, visual layers,
// chrome, node-actions, drop-intents, and content renderers are all FACETS of a
// node, each resolved from a registry keyed by a self-describing string (the
// node's `family`, or a content `kind`). This presents that lookup as one tiny
// generic contract so every consumer dispatches by DATA — never `switch(family)`
// / `switch(kind)` (L090, enum-dissolution).
//
// SSOT: this does NOT own or duplicate the existing visual-layer / node-action /
// drop-intent / renderer registries — those stay the owners. A `FacetRegistry`
// is a thin uniform VIEW over a `Map<string, T>` (or an adapter around an
// existing registry's `get`). Adding a capability = one DATA row; the resolver
// never changes.

/** The uniform capability-resolution contract: a key → a capability, or undefined. */
export interface FacetRegistry<T> {
  /** Resolve the capability for `key`, or undefined when none is registered (caller renders a safe fallback). */
  resolve(key: string): T | undefined
  /** Every registered key (for deriving menus/options from DATA — never a hardcoded list). */
  keys(): readonly string[]
}

/** Build a FacetRegistry from a plain record/map of capabilities (the common case). */
export function facetRegistryFromMap<T>(entries: ReadonlyMap<string, T> | Readonly<Record<string, T>>): FacetRegistry<T> {
  const map: ReadonlyMap<string, T> = entries instanceof Map ? entries : new Map(Object.entries(entries))
  return {
    resolve(key: string): T | undefined {
      return map.get(key)
    },
    keys(): readonly string[] {
      return [...map.keys()]
    },
  }
}

/**
 * Adapt an EXISTING registry (one that already exposes a `get(key)`), without
 * copying it — the existing registry stays the single source of truth. `keyList`
 * supplies the enumerable keys (e.g. the registry's own ordered capability list).
 */
export function facetRegistryFromGetter<T>(
  get: (key: string) => T | undefined,
  keyList: () => readonly string[],
): FacetRegistry<T> {
  return { resolve: get, keys: keyList }
}

/**
 * Resolve a capability for a node, or fall back. The fallback makes the resolver
 * total: an unknown family/kind never crashes the render (L083/L090) — it yields
 * a safe default the consumer can render (e.g. a generic chip).
 */
export function resolveFacet<T>(registry: FacetRegistry<T>, key: string, fallback: T): T {
  return registry.resolve(key) ?? fallback
}
