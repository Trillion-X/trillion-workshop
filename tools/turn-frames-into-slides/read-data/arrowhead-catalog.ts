// tools/turn-frames-into-slides/read-data/arrowhead-catalog.ts
//
// ARROWHEAD SHAPE AS DATA — the enum-dissolution of the connector arrowhead, the exact twin of R3's
// "a bullet can be ANYTHING" applied to line ends. A connector's arrowhead was a single hardcoded triangle
// `<marker>` in the render layer, with only its DIRECTION (end/both/none) expressed as DATA; its SHAPE was
// Society frozen into Physics. This leaf makes the shape self-describing DATA: each `ArrowheadShape` carries
// the marker `path` + whether it is `filled` and/or `stroked` + its tip `refX`, so a blind renderer emits a
// `<marker>` from the row and every connector end selects a shape by id. Adding an arrowhead (chevron, tee,
// cross, custom) is ONE DATA row — zero render code, on BOTH the live board and the SVG export, from this
// one shared catalog (L069/L090/enum-dissolution). `none` is the empty-path sentinel (a headless line).
//
// Pure leaf (no React/DOM/colour). The two renderers (ConnectorLayer, board-svg export) substitute the
// paint: the live layer fills/strokes with `context-stroke` (each line's own colour); the export with the
// connector's literal colour — same geometry, one SSOT, live == export.

export interface ArrowheadShape {
  readonly id: string;
  readonly label: string;
  /** The marker `<path d>` in a `0 0 10 10` viewBox with the tip at the right; `''` for `none`. */
  readonly path: string;
  /** Whether the shape is a filled area (triangle/diamond/disc) vs an open outline (chevron/bar). */
  readonly filled: boolean;
  readonly stroked: boolean;
  /** The x the marker pins to the line end (the tip), so the head sits AT the endpoint, not past it. */
  readonly refX: number;
}

export const CONNECTOR_ARROWHEADS: ReadonlyArray<ArrowheadShape> = [
  // triangle FIRST = the default (its path/refX are byte-identical to the pre-b94 hardcoded marker).
  { id: 'triangle', label: 'Triangle', path: 'M 0 0 L 10 5 L 0 10 z', filled: true, stroked: false, refX: 8.5 },
  { id: 'open', label: 'Open', path: 'M 0 0 L 10 5 L 0 10', filled: false, stroked: true, refX: 8.5 },
  { id: 'diamond', label: 'Diamond', path: 'M 0 5 L 5 0 L 10 5 L 5 10 z', filled: true, stroked: false, refX: 9 },
  { id: 'circle', label: 'Circle', path: 'M 5 1 A 4 4 0 1 0 5 9 A 4 4 0 1 0 5 1 z', filled: true, stroked: false, refX: 9 },
  { id: 'bar', label: 'Bar', path: 'M 9 0 L 9 10', filled: false, stroked: true, refX: 9 },
  { id: 'none', label: 'None', path: '', filled: false, stroked: false, refX: 8.5 },
];

/** Resolve an arrowhead shape by id; an unknown/absent id → the `triangle` default (byte-identical). */
export function arrowheadById(id: string | undefined): ArrowheadShape {
  return CONNECTOR_ARROWHEADS.find((a) => a.id === id) ?? CONNECTOR_ARROWHEADS[0];
}

/** The picker rows for the board default: every shape as `{value,label}`, derived from the catalog SSOT. */
export const CONNECTOR_ARROWHEAD_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  CONNECTOR_ARROWHEADS.map((a) => ({ value: a.id === 'triangle' ? '' : a.id, label: a.label }));
