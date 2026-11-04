// packages/group/show/frame-aspects.ts
//
// The board's catalog of named frame aspect ratios — pure DATA. Each entry maps a
// human label ("16 : 9 · Widescreen slide") to a width:height ratio a presentation
// FRAME can be reshaped into (#177). Reshaping keeps the frame's top-left + width and
// conforms the height to the ratio (the FigJam/Figma frame-preset behaviour) via the
// pure `resizeToAspect` geometry in `board-frames.ts`.
//
// Adding a ratio is ONE row here — zero engine/render/geometry code changes (L090): the
// picker (in the bulk bar) renders these labels and reports an `id`; it never knows what
// an aspect ratio IS or how a frame is resized. This is Society DATA living in the
// feature package, exactly like `BOARD_FILTER_PRESETS` / `BOARD_SHAPES` — not the ui
// engine, not a closed TS enum, not a `switch (ratio)` in the panel.

/** One named frame aspect: a label the user picks + the `w : h` ratio it applies. */
export interface FrameAspect {
  /** Stable id stored/looked-up (never the label — labels can change). */
  readonly id: string;
  /** Human label shown on the picker row (already in the user's language). */
  readonly label: string;
  /** Ratio width term (must be > 0). Only the RATIO `w / h` matters, not the units —
   *  `16/9` and `1920/1080` are identical, and `210/297` expresses A4. */
  readonly w: number;
  /** Ratio height term (must be > 0). */
  readonly h: number;
}

/** The starting slide/print catalog. Order = display order; widescreen first. */
export const FRAME_ASPECTS: readonly FrameAspect[] = [
  { id: '16:9', label: '16 : 9 · Widescreen slide', w: 16, h: 9 },
  { id: '4:3', label: '4 : 3 · Classic slide', w: 4, h: 3 },
  { id: '1:1', label: '1 : 1 · Square', w: 1, h: 1 },
  { id: '3:4', label: '3 : 4 · Portrait', w: 3, h: 4 },
  { id: '9:16', label: '9 : 16 · Story / phone', w: 9, h: 16 },
  { id: 'a4', label: 'A4 · Print portrait', w: 210, h: 297 },
];

/** Resolve an aspect id → its entry (`null` when unknown). */
export function frameAspectById(
  id: string | undefined,
  list: readonly FrameAspect[] = FRAME_ASPECTS,
): FrameAspect | null {
  if (!id) return null;
  return list.find((a) => a.id === id) ?? null;
}
