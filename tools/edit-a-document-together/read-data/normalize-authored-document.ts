// package-set://bitfield-studio/packages/documents/read-data/normalize-authored-document.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The ONE pure load/write boundary normalizer for an authored composition
// document. It repairs a stored (possibly corrupt) document into one that is
// GUARANTEED to satisfy the composition engine's SceneIndex invariants, so the
// editor can ALWAYS open — no stored document can ever brick the load
// ("Pages could not load"). This structurally eliminates the whole category of
// load-time engine-invariant failures (L055/L063) instead of catching them one
// at a time.
//
// INVARIANTS ENFORCED (each = a way a stored doc could otherwise brick load):
//   1. UNIQUE node ids across the WHOLE tree. The engine's SceneIndex hard-
//      rejects a repeated id (which throws and bricks every future load). A
//      genuine duplicate (a double-save that repeated real nodes) is DROPPED,
//      keeping the first occurrence — the recovered tree is the intended one.
//   2. RESERVED ROOT id. The engine owns the root container id; a stored node
//      that claims it collides. Such a node is RE-MINTED (content preserved),
//      never dropped.
//   3. VALID, PRESENT id. A node with a missing / empty / non-string / bad-
//      charset id is RE-MINTED (content preserved), never silently dropped.
//   4. CORRUPT payloads. A null / non-object node is quarantined (dropped).
//   5. LIVE edges only. An edge whose source/target id no longer resolves after
//      id repair is dropped; an edge whose endpoints were re-minted is rewritten
//      through the id remap. A dangling edge would reference a missing node.
//
// WHY re-mint some and drop others: a repeated VALID id means the SAME node was
// serialized twice (corruption of quantity) → the duplicate is redundant, drop
// it. An INVALID / reserved id means a REAL node that merely lost / collided on
// its handle → keep the node, give it a fresh handle.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE. No I/O, no engine calls, no globals. Deterministic given the same
//    input + mint. The `mint` id generator is injectable so tests are exact and
//    there is zero reliance on Math.random / Date.
// 2. CONTENT-PRESERVING where possible. Only genuine duplicates and
//    unrepairable corrupt payloads are dropped; everything repairable is kept.
// 3. IDEMPOTENT. Normalizing an already-clean document returns it unchanged
//    (repaired === false) with the same ids.
// =============================================================================

import type {
  SceneNode,
  EdgeConnection,
} from './documents';

export interface NormalizedDocument {
  readonly children: SceneNode[];
  readonly edges: EdgeConnection[];
  /** True when ANY repair happened — a clean document normalizes to `false`. */
  readonly repaired: boolean;
}

/** Conservative valid-id charset: word chars plus the separators authored ids
 *  use (`node:one`, `blk-2`, `page.1`). Anything else is treated as corrupt. */
const VALID_ID = /^[\w.:-]+$/;

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && VALID_ID.test(id);
}

/** Recursively drop `null`-valued keys from a plain object. The composition
 *  engine's transaction decode gives each node field a concrete serde type
 *  (e.g. `props.style` is a MAP, `props.text` is a STRING); a stored `null`
 *  there is NOT "the default", it is a type mismatch that PANICS the decode and
 *  bricks the whole load. These fields are optional — absent is the valid empty
 *  state — so a null key is equivalent to (and must become) an omitted key.
 *  Returns the same reference when nothing was null (idempotent, no churn). */
function stripNullKeys(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = stripNullKeys(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === null) { changed = true; continue; } // drop the null key
      const r = stripNullKeys(child);
      if (r.changed) changed = true;
      next[key] = r.value;
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

export function normalizeAuthoredDocument(
  children: readonly SceneNode[] | undefined,
  edges: readonly EdgeConnection[] | undefined,
  options: { rootId?: string; mint?: () => string } = {},
): NormalizedDocument {
  const rootId = options.rootId ?? 'root';
  let counter = 0;
  const mintRaw = options.mint ?? (() => `norm:${(counter += 1)}`);
  const seen = new Set<string>([rootId]); // root id is reserved — no node may hold it
  const remap = new Map<string, string>(); // old valid id -> new id (root-collision re-mints)
  let repaired = false;

  const mintUnique = (): string => {
    let fresh = mintRaw();
    while (seen.has(fresh)) fresh = mintRaw();
    seen.add(fresh);
    return fresh;
  };

  // Returns the id this node should keep, or `null` to DROP it (genuine duplicate).
  const claimId = (rawId: unknown): string | null => {
    if (!isValidId(rawId)) {
      repaired = true;
      return mintUnique(); // invalid/missing/empty id -> re-mint, keep the node
    }
    if (rawId === rootId) {
      repaired = true;
      const fresh = mintUnique();
      remap.set(rawId, fresh); // edges to the old id follow the re-mint
      return fresh;
    }
    if (seen.has(rawId)) {
      repaired = true;
      return null; // duplicate of an already-kept node (double-save) -> drop
    }
    seen.add(rawId);
    return rawId;
  };

  const walk = (nodes: readonly SceneNode[] | undefined): SceneNode[] => {
    const out: SceneNode[] = [];
    for (const node of nodes ?? []) {
      if (!node || typeof node !== 'object') {
        repaired = true; // corrupt payload -> quarantine
        continue;
      }
      const newId = claimId(node.id);
      if (newId === null) continue; // dropped duplicate
      // Strip decode-breaking `null`s from the typed sub-objects (props/style).
      // Top-level node fields (z_index, portal_owner) legitimately allow null
      // (serde Option) and are left untouched.
      const rebuilt: SceneNode = { ...node, id: newId, children: walk(node.children) };
      if (node.props !== undefined && node.props !== null) {
        const r = stripNullKeys(node.props);
        if (r.changed) { rebuilt.props = r.value as Record<string, unknown>; repaired = true; }
      }
      if (node.style !== undefined && node.style !== null) {
        const r = stripNullKeys(node.style);
        if (r.changed) { rebuilt.style = r.value as Record<string, unknown>; repaired = true; }
      }
      out.push(rebuilt);
    }
    return out;
  };

  const normChildren = walk(children);

  const normEdges: EdgeConnection[] = [];
  for (const edge of edges ?? []) {
    if (!edge || typeof edge !== 'object' || typeof edge.source_id !== 'string' || typeof edge.target_id !== 'string') {
      repaired = true;
      continue;
    }
    const src = remap.get(edge.source_id) ?? edge.source_id;
    const tgt = remap.get(edge.target_id) ?? edge.target_id;
    if (!seen.has(src) || !seen.has(tgt)) {
      repaired = true; // dangling edge -> drop
      continue;
    }
    if (src !== edge.source_id || tgt !== edge.target_id) repaired = true;
    normEdges.push({ ...edge, source_id: src, target_id: tgt });
  }

  return { children: normChildren, edges: normEdges, repaired };
}
