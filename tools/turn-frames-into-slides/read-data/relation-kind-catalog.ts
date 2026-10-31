// tools/turn-frames-into-slides/read-data/relation-kind-catalog.ts
//
// A DATA catalog mapping a relationship kind → how it reads and draws: a human label, a
// colour, and a directionality. This is Society (which relationships exist, what they're
// called) kept OUT of engine code — exactly like the bullet-marker catalog. A product adds
// a relationship kind by adding a row here (or an injected override), never by editing a
// dispatcher (L090). The graph engine (relationship-graph.ts) treats the kind as opaque; only
// this presentation layer names them.

export interface RelationKindSpec {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  /** How the connector points: 'end' (from→to), 'both', or 'none'. */
  readonly arrow?: 'end' | 'both' | 'none';
}

/** Built-in relationship kinds. A product may pass its own map to override/extend. */
export const DEFAULT_RELATION_KINDS: Readonly<Record<string, RelationKindSpec>> = {
  'relates-to': { id: 'relates-to', label: 'relates to', color: '#8b8f98', arrow: 'both' },
  'depends-on': { id: 'depends-on', label: 'depends on', color: '#3b6fe0', arrow: 'end' },
  blocks: { id: 'blocks', label: 'blocks', color: '#e5484d', arrow: 'end' },
  'parent-of': { id: 'parent-of', label: 'parent of', color: '#12a150', arrow: 'end' },
  'leads-to': { id: 'leads-to', label: 'leads to', color: '#a855f7', arrow: 'end' },
};

/** Resolve a kind to its spec — an unknown kind falls back to a generic labelled spec
 *  (the raw kind as its label), so a never-before-seen relationship still renders (L083). */
export function relationKindSpec(
  kind: string,
  catalog: Readonly<Record<string, RelationKindSpec>> = DEFAULT_RELATION_KINDS,
): RelationKindSpec {
  // Own-key lookup only: `kind` is untrusted (a connector's `extra.relationKind`). A plain `catalog[kind]`
  // with kind '__proto__'/'constructor' returns Object.prototype/Object (truthy), which SKIPS the `??`
  // fallback and yields a bogus spec with undefined label/color/arrow — the exact opposite of the L083
  // "unknown kind still renders with a generic labelled spec" contract. hasOwn routes it to the fallback.
  const own = Object.prototype.hasOwnProperty.call(catalog, kind) ? catalog[kind] : undefined;
  return own ?? { id: kind, label: kind.replace(/[-_]/g, ' '), color: '#8b8f98', arrow: 'end' };
}

/**
 * The DISPLAY label for a connector's midpoint chip — the ONE resolver both the live layer
 * (`buildConnectorModels`) and the SVG export (`board-svg`) read, so a typed relationship's label
 * appears IDENTICALLY on screen and in the export (live == export, ML085). An explicit `extra.label`
 * always wins (including an empty string, which deliberately SUPPRESSES the label); otherwise a
 * connector carrying `extra.relationKind` takes that kind's catalog label ('depends-on' → "depends
 * on"). No relationKind and no explicit label → `undefined` (a bare line). Pure; catalog injectable.
 */
export function connectorLabelOf(
  extra: Record<string, unknown> | undefined,
  catalog: Readonly<Record<string, RelationKindSpec>> = DEFAULT_RELATION_KINDS,
): string | undefined {
  const ex = extra ?? {};
  if (typeof ex.label === 'string') return ex.label; // explicit label wins ('' = suppress)
  const relationKind = typeof ex.relationKind === 'string' && ex.relationKind.length > 0 ? ex.relationKind : undefined;
  return relationKind ? relationKindSpec(relationKind, catalog).label : undefined;
}
