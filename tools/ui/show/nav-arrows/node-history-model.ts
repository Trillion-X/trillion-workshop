// packages/ui/show/nav-arrows/node-history-model.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pure, generic navigation-history cursor model behind NavArrows. A "trail"
// is an ordered list of visited refs plus a cursor; back/forward move the cursor
// with standard browser semantics (recording a NEW ref while mid-stack drops the
// forward entries). It is kind-blind and storage-blind: a `ref` is an opaque
// string the OWNER knows how to re-open (a tabId, a URL), and WHERE the trail
// persists is the owner's choice (a LayoutState side-map, a web-frame's own
// state). This is the single source of truth for the cursor math — both the
// screen-arrangement (per-pane tab history) and web-frame (URL history) consume
// it, neither re-implements it (L069/L030).
// =============================================================================

export interface NodeHistoryEntry {
  /** Opaque ref the owner re-opens (tabId, URL, …). */
  readonly ref: string;
  /** Human label for the entry. */
  readonly label: string;
  /** Visit timestamp (ms since epoch). */
  readonly ts: number;
}

export interface NodeHistoryTrail {
  readonly entries: readonly NodeHistoryEntry[];
  /** Index into `entries` of the currently-shown ref; -1 when empty. */
  readonly cursor: number;
}

/**
 * Record a visit to `entry.ref`. Returns the next trail, or `null` when the ref
 * already sits at the cursor (re-selecting the current ref is not a navigation),
 * so callers can no-op cheaply. Recording mid-stack drops the forward entries.
 */
export function recordVisit(
  trail: NodeHistoryTrail | null,
  entry: NodeHistoryEntry,
): NodeHistoryTrail | null {
  if (trail && trail.entries[trail.cursor]?.ref === entry.ref) return null;
  const kept = trail ? trail.entries.slice(0, trail.cursor + 1) : [];
  const entries = [...kept, entry];
  return { entries, cursor: entries.length - 1 };
}

/** Move the cursor back one; returns the next trail + the ref to re-open, or null. */
export function stepBack(
  trail: NodeHistoryTrail | null,
): { trail: NodeHistoryTrail; ref: string } | null {
  if (!trail || trail.cursor <= 0) return null;
  const cursor = trail.cursor - 1;
  return { trail: { entries: trail.entries, cursor }, ref: trail.entries[cursor].ref };
}

/** Move the cursor forward one; returns the next trail + the ref to re-open, or null. */
export function stepForward(
  trail: NodeHistoryTrail | null,
): { trail: NodeHistoryTrail; ref: string } | null {
  if (!trail || trail.cursor >= trail.entries.length - 1) return null;
  const cursor = trail.cursor + 1;
  return { trail: { entries: trail.entries, cursor }, ref: trail.entries[cursor].ref };
}

export function canStepBack(trail: NodeHistoryTrail | null): boolean {
  return !!trail && trail.cursor > 0;
}

export function canStepForward(trail: NodeHistoryTrail | null): boolean {
  return !!trail && trail.cursor < trail.entries.length - 1;
}

/** The ref currently shown by the cursor, or null when empty/out of range. */
export function currentRef(trail: NodeHistoryTrail | null): string | null {
  if (!trail || trail.cursor < 0 || trail.cursor >= trail.entries.length) return null;
  return trail.entries[trail.cursor].ref;
}

/** Clamp a (possibly persisted) cursor into range — used by normalizers. */
export function clampCursor(trail: NodeHistoryTrail): NodeHistoryTrail {
  return { entries: trail.entries, cursor: Math.max(-1, Math.min(trail.cursor, trail.entries.length - 1)) };
}
