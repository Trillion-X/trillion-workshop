// packages/group/do-work/content-placement.ts
//
// ITEM CONTENT PLACEMENT — the generative primitive behind "where the note's text sits inside its box"
// (the Figma/FigJam sticky-note canon: text top-left, dead-centre, bottom-right, …). A card's content had
// exactly one placement (top-left flow); this maps a NORMALIZED anchor `{nx, ny}` in 0..1 — the SAME
// continuous-anchor form the connector fixed-ports use (`ConnectorAnchor`) — to the CSS a blind renderer
// applies: `justifyContent` (vertical, the column main axis), `alignItems` (horizontal, the cross axis),
// and `textAlign`. Each axis is bucketed to start/center/end (the only positions flexbox/`text-align`
// express), so infinitely many `{nx,ny}` inputs resolve through ONE resolver with zero per-position code —
// the nine named presets below are just DATA rows over it, not nine branches (L069/L090/enum-dissolution).
//
// Pure leaf (no React/DOM). The renderer stays blind: it applies the returned style and never enumerates
// "top-left" vs "center" — a new preset is one DATA row, a custom placement is any `{nx,ny}` pair.

/** A normalized content anchor: `{0,0}` = top-left, `{0.5,0.5}` = centre, `{1,1}` = bottom-right. */
export interface ContentAnchor {
  readonly nx: number;
  readonly ny: number;
}

/** The CSS a blind card applies to place its content (a column flex box). */
export interface ContentPlacement {
  readonly justifyContent: 'flex-start' | 'center' | 'flex-end';
  readonly alignItems: 'flex-start' | 'center' | 'flex-end';
  readonly textAlign: 'left' | 'center' | 'right';
}

const FLEX = ['flex-start', 'center', 'flex-end'] as const;
const TEXT = ['left', 'center', 'right'] as const;

/** Bucket a normalized 0..1 coordinate to one of the three positions an axis can express (0/1/2). A
 *  non-finite value falls back to 0 (start), so a malformed anchor never throws or produces `NaN` CSS. */
export function bucket(t: number): 0 | 1 | 2 {
  if (!Number.isFinite(t)) return 0;
  return t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
}

/**
 * The content placement CSS for a normalized anchor. `nx` drives the HORIZONTAL axis (`alignItems` — the
 * column's cross axis — and `textAlign`); `ny` drives the VERTICAL axis (`justifyContent` — the main axis).
 * One resolver, every `{nx,ny}` → one placement, zero per-position code.
 */
export function contentPlacement(nx: number, ny: number): ContentPlacement {
  const h = bucket(nx);
  const v = bucket(ny);
  return { justifyContent: FLEX[v], alignItems: FLEX[h], textAlign: TEXT[h] };
}

/** Nine common placements as DATA (the picker's presets); the resolver above is blind to this list — a new
 *  preset is one row, and any `{nx,ny}` outside these nine resolves identically through `contentPlacement`. */
export const CONTENT_ANCHORS: ReadonlyArray<{ value: string; label: string; nx: number; ny: number }> = [
  { value: 'top-left', label: 'Top left', nx: 0, ny: 0 },
  { value: 'top-center', label: 'Top center', nx: 0.5, ny: 0 },
  { value: 'top-right', label: 'Top right', nx: 1, ny: 0 },
  { value: 'middle-left', label: 'Middle left', nx: 0, ny: 0.5 },
  { value: 'center', label: 'Center', nx: 0.5, ny: 0.5 },
  { value: 'middle-right', label: 'Middle right', nx: 1, ny: 0.5 },
  { value: 'bottom-left', label: 'Bottom left', nx: 0, ny: 1 },
  { value: 'bottom-center', label: 'Bottom center', nx: 0.5, ny: 1 },
  { value: 'bottom-right', label: 'Bottom right', nx: 1, ny: 1 },
];

/** Resolve a placement from self-describing DATA: a preset id (a `CONTENT_ANCHORS` value) OR a raw
 *  `{nx,ny}` anchor object (a custom placement). Anything else → null (no placement → renderer untouched). */
export function contentAnchorFrom(value: unknown): ContentAnchor | null {
  if (typeof value === 'string') {
    const row = CONTENT_ANCHORS.find((a) => a.value === value);
    return row ? { nx: row.nx, ny: row.ny } : null;
  }
  if (value && typeof value === 'object') {
    const v = value as { nx?: unknown; ny?: unknown };
    if (typeof v.nx === 'number' && typeof v.ny === 'number') return { nx: v.nx, ny: v.ny };
  }
  return null;
}
