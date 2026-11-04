// packages/group/do-work/circle-layout.ts
//
// The ONE circle-layout RADIUS rule — shared by EVERY "arrange in circle" affordance so they can
// never drift. Both the selected-item Arrange menu (show/arrange-strategies `circle`) and the bulk
// bar / ⌘K "Arrange in circle" (do-work/batch-actions `radialPlacement`) call this. Before, each
// inlined its OWN radius formula — the menu used a fixed `max(120, count*20)` (an arbitrary 20px per
// item, ignoring box size), the bulk bar used the pitch-derived `max(pitch, count*pitch/2π)` — so the
// SAME selection produced a geometrically DIFFERENT circle depending on which control the user used
// (Codex arrange-audit F6). This leaf makes that drift structurally impossible (L063 / SSOT).
//
// The radius is derived from the box PITCH (largest box dimension + gap), NOT a fixed per-item
// constant: the ring's circumference must seat `count` boxes at `pitch` spacing without overlap, so
//     circumference = count * pitch   →   radius = count * pitch / (2π)
// floored at `pitch` so a 1–2 item ring never collapses to a point. This is the principled formula
// (boxes scale with their own size), which is why it — not the arbitrary `count*20` — is the SSOT.
//
// Pure, deterministic, zero I/O.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/**
 * The radius of the ring that seats `count` boxes of uniform `pitch` (largest box dimension + gap)
 * without overlap. `radius = max(pitch, count * pitch / 2π)`. Fail-safe on degenerate input: a
 * non-positive/non-finite pitch is treated as 1, and count is floored at 1.
 */
export function circleLayoutRadius(count: number, pitch: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const p = Number.isFinite(pitch) && pitch > 0 ? pitch : 1;
  return Math.max(p, (n * p) / (2 * Math.PI));
}
