// parts/ui/show/loading-mark/stitch.ts
//
// PURPOSE
//   The one loading animation's drawing, as plain data both its React form (LoadingMark.tsx) and the server-drawn
//   pages' script (parts/ui/show/server-rendered-page/page-work.mjs) draw from, so the mark is the same everywhere.

/** The stitch the needle follows and the thread lies along: one path, in the mark's 64 x 24 box. */
export const STITCH_PATH = 'M4 15 C 10 5, 17 5, 22 12 S 32 21, 38 13 S 50 5, 60 9';
/** The needle's body and its eye, drawn at the start of the stitch and moved along it by the look. */
export const NEEDLE_BODY = 'M-9 -0.9 L5 -0.45 L9 0 L5 0.45 L-9 0.9 Z';
export const NEEDLE_EYE = { cx: -6.2, cy: 0, rx: 1.6, ry: 0.35 };
