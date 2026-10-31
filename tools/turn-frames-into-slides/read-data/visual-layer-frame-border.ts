// tools/turn-frames-into-slides/read-data/visual-layer-frame-border.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE canonical reader for a stack-root frame's border DATA (`FrameDef.border`).
// It lives HERE — beside `FrameDef` in the shared visual-layer-stack UI — because
// this is the bedrock that OWNS the frame schema (L088 recursive-CSSOT placement):
// the `FrameControl` that WRITES the border and every consumer that RENDERS it both
// normalize through this single function, so the two can never drift into two
// schemas (the exact divergence this fixed downstream: a live render reading a
// boolean while an exporter read an object).
//
// `FrameDef.border` is a SUPERSET, expressible as every state a border can be in:
//   • hidden            → false                         → { show: false }
//   • default chrome     → true / undefined              → { show: true }
//   • custom stroke      → { color?, width? }            → { show: true, color?, width? }
//   • explicit hide+data → { show: false, color?, … }    → { show: false, color?, … }
//
// A legacy boolean is tolerated forever (existing frame DATA carries it), so richer
// borders are additive, never a migration.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** The custom-stroke object form of `FrameDef.border`. */
export interface FrameBorderSpec {
  show?: boolean;
  color?: string;
  width?: number;
}

/** The normalized border every surface reads: `show` gates whether ANY border paints;
 *  `color`/`width` are the custom stroke when present (absent → the surface default). */
export interface FrameBorder {
  show: boolean;
  color?: string;
  width?: number;
}

/**
 * Normalize the self-describing `FrameDef.border` into the canonical `FrameBorder`.
 * Total and fail-soft — any malformed value resolves to a shown default border, never
 * throws, never a partial. The ONLY place the border wire-format is parsed.
 */
export function readFrameBorder(border: unknown): FrameBorder {
  if (border === false) return { show: false };
  if (border && typeof border === 'object') {
    const b = border as { color?: unknown; width?: unknown; show?: unknown };
    const color = typeof b.color === 'string' && b.color.length > 0 ? b.color : undefined;
    const width =
      typeof b.width === 'number' && Number.isFinite(b.width) && b.width > 0 ? b.width : undefined;
    return { show: b.show === false ? false : true, color, width };
  }
  // `true`, `undefined`, a number, a string — anything else means "show the default".
  return { show: true };
}
