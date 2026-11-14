// frontends/web/src/packages/ui/show/graph-status/graph-status-view.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DATA-driven status/activity decoder for record-topology nodes and edges.
// This is the Physics-vs-Society boundary of the graph: the renderer must NEVER
// know that "running"/"done"/"error"/"queued" exist. It receives a RAW status
// KEY (any string, straight off a record's status field) plus a DATA `overrides`
// map, and resolves a view-model {key, label, tone, pulse, dim}. Product meaning
// (which key is "good", what colour tone, whether it pulses) lives ENTIRELY in
// the overrides DATA — never in a closed TypeScript union, never in an
// `if (status === 'running')` branch.
//
// This is L090 (self-describing data, generic handler) + enum-dissolution made
// concrete: a new status/kind appears by adding ONE overrides row, ZERO code
// change. Delete every override and the decoder still works (falls back to a
// humanized label + neutral tone) — proving it hardcodes nothing.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO closed status/kind union — `key` is an arbitrary string.
// 2. NO product vocabulary in this file — no "worker", "run", "coach",
//    "running", "done". Those are DATA keys supplied by the caller.
// 3. TOTAL — every key resolves to a complete view-model, even an unknown key
//    with no override (humanized label + neutral tone, no pulse, no dim).
// 4. PURE + DETERMINISTIC — same (key, overrides) → same view-model.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** One DATA override row: how a raw status/activity key should present. All
 *  fields are supplied by DATA; any absent field falls to a neutral default. */
export interface StatusOverride {
  /** Human-facing label; when absent the raw key is humanized. */
  readonly label?: string;
  /** Presentation tone — an opaque token string the look layer maps to colour
   *  (e.g. "positive", "danger", "muted"). The decoder never interprets it. */
  readonly tone?: string;
  /** Whether the node/edge should animate (pulse / flowing dashes) — live work. */
  readonly pulse?: boolean;
  /** Whether the node/edge should be de-emphasized (dimmed) — inactive/retired. */
  readonly dim?: boolean;
}

/** The DATA overrides map: raw key → presentation. Missing keys are tolerated. */
export type StatusOverrides = Readonly<Record<string, StatusOverride>>;

/** The resolved presentation view-model the renderer consumes. Complete + total. */
export interface StatusView {
  readonly key: string;
  readonly label: string;
  readonly tone: string;
  readonly pulse: boolean;
  readonly dim: boolean;
}

/** Neutral defaults applied when a key has no (or a partial) override. */
const NEUTRAL_TONE = 'neutral';

// ---------------------------------------------------------------------------
// HUMANIZE (deterministic key → label fallback)
// ---------------------------------------------------------------------------

/**
 * Turn a raw key into a readable label when DATA gives none.
 * `in_progress` / `in-progress` / `inProgress` → `In progress`. Deterministic,
 * lossless-ish, zero domain knowledge. An empty/blank key → empty string.
 */
export function humanizeKey(key: string): string {
  if (!key) return '';
  const spaced = key
    .replace(/[_-]+/g, ' ')                    // snake / kebab → spaces
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')    // camelCase → words
    .trim()
    .replace(/\s+/g, ' ');
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// RESOLVE (the ONE place a key → presentation is decided)
// ---------------------------------------------------------------------------

/**
 * Resolve a raw status/activity key against DATA overrides into a total
 * view-model. This is the generic handler the renderer calls for every node
 * and edge — it enumerates nothing.
 *
 * @param rawKey    the record's own status/activity value (any string)
 * @param overrides DATA map key → presentation (may be empty / undefined)
 * @returns a complete StatusView (never partial, never throws)
 */
export function resolveStatusView(rawKey: string | null | undefined, overrides?: StatusOverrides): StatusView {
  const key = (rawKey ?? '').toString();
  const o = (overrides && overrides[key]) || {};
  return {
    key,
    label: o.label ?? humanizeKey(key),
    tone: o.tone ?? NEUTRAL_TONE,
    pulse: o.pulse ?? false,
    dim: o.dim ?? false,
  };
}

/**
 * Resolve an EDGE's live activity into whether it should flow (animate) and its
 * tone. An edge "flows" when its activity key's override says pulse:true — the
 * same DATA mechanism as nodes, so an in-flight run animates its edge purely
 * from DATA. Absent activity → a still edge with neutral tone.
 *
 * @param activityKey the edge's activity/status value (any string or nullish)
 * @param overrides   the same DATA overrides map used for nodes
 */
export function resolveEdgeActivity(activityKey: string | null | undefined, overrides?: StatusOverrides): { flowing: boolean; tone: string; key: string } {
  const view = resolveStatusView(activityKey, overrides);
  return { flowing: view.pulse, tone: view.tone, key: view.key };
}
