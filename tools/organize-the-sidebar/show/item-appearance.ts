// packages/group/show/item-appearance.ts
//
// The APPEARANCE-DEFAULTS CASCADE primitive (P1) — pure, zero I/O. The product mandate: NOTHING
// about how a board item looks may be hardcoded in source ("why are WE deciding? it should ALL
// be data-configurable, per-board, presettable"). Today the note container is hardcoded to the
// 'surface' (glassmorph) variant (`item-renderers.tsx` `surfaceVariant` ignores its arg), text
// sizing is fixed to auto-height, palettes are hardcoded, etc. — Society leaking into Physics.
//
// This leaf owns the ONE resolution rule every appearance property flows through:
//   GLOBAL default  ←overridden by→  per-BOARD default  ←overridden by→  per-ITEM override
// The blind renderer reads the RESOLVED value; no hardcoded default survives in source. Adding a
// NEW appearance property = one key in the GLOBAL_APPEARANCE profile (DATA) + one read call —
// ZERO new branching (L090). `sizeMode` (fit/fill/scroll and infinite future modes via the
// capability map) is the first property wired through it — Society as records over the engine.

import { MARKER_DEFAULT_OPTIONS } from './board-marker-catalog.ts';
import { CONTENT_ANCHORS } from '../do-work/content-placement.ts';
import { ELEVATION_LEVELS } from '../do-work/elevation-shadow.ts';
import { CONNECTOR_ARROWHEAD_OPTIONS } from '../do-work/arrowhead-catalog.ts';
import { BOARD_FILTER_PRESETS } from './filter-presets.ts';
import { SHAPE_DEFAULT_OPTIONS } from './board-shapes.ts';
import { STROKE_STYLES } from './stroke-style.ts';
import { ownValue } from '../read-data/facet-filter.ts';
import { finiteCoord } from '../read-data/finite-coord.ts';

/** A bag of appearance defaults (board or global), keyed by appearance property name. Every
 *  value is opaque DATA — this leaf never enumerates which keys are "allowed" (L090). */
export type AppearanceProfile = Record<string, unknown>;

/** The GLOBAL fallback profile — the last-resort defaults when neither the board nor the item
 *  specifies a property. These reproduce today's hardcoded look so the cascade is zero-regression
 *  until a board/item overrides. This is the ONLY place a global default lives (SSOT), and it is
 *  DATA (a plain record), not scattered `?? 'surface'` literals across the renderer. */
export const GLOBAL_APPEARANCE: AppearanceProfile = {
  containerVariant: 'surface', // was hardcoded in surfaceVariant() — now the global default
  sizeMode: 'fit', // was implicit (auto-height only); now an explicit, overridable default
  padding: 'md', // note-card density — was hardcoded `padding="md"`; now board-presettable (none/xs/sm/md/lg)
  defaultWidth: 220, // new-item footprint — was hardcoded `DEFAULTS.w`; now board-presettable
  defaultHeight: 160, // new-item footprint — was hardcoded `DEFAULTS.h`; now board-presettable
  // R2b — the board-wide DEFAULT connector look (the idle line when a connector has no per-line
  // `extra.color`/`thickness` and no relationKind spec). Was hardcoded `IDLE`/`2` in ConnectorLayer;
  // now a board can theme all its default connectors (per-connector overrides + relationKind still win).
  connectorColor: 'var(--border-strong, rgba(100, 116, 139, 0.85))', // = the old IDLE literal (zero-regression)
  connectorWidth: 2, // = the old hardcoded baseWidth fallback
  connectorArrow: 'end', // = the old `c.arrow ?? 'end'` fallback in ConnectorLayer (zero-regression)
  connectorRouting: 'straight', // = the old `c.routing ?? 'straight'` fallback (zero-regression)
  connectorDashed: false, // = the old `c.dashed ? … : undefined` fallback = solid (zero-regression); a per-line raw override
  connectorRoughness: 0, // cont.26 — a RAW per-line roughness override; 0 = crisp (zero-regression), >0 = pencil/sketch
  connectorStrokeStyle: 'solid', // cont.26 Line-style axis — the NAMED brushstroke (solid/dashed/dotted/pencil/marker/sketch); resolves to roughness+bowing+dash
  borderStrokeStyle: 'solid', // cont.26 Line-style for BORDERS — the note-border NAMED brushstroke (same catalog); solid = the plain card border
};

/** Resolve the default footprint for a NEW item through the appearance cascade (R2b fold of the
 *  hardcoded `DEFAULTS {w:220,h:160}`). No item exists yet → no item override, so the BOARD's
 *  `defaultWidth`/`defaultHeight` win over the GLOBAL 220×160. A non-positive/non-number board
 *  value falls through to the global (fail-safe — a bad preset never yields a zero-size item).
 *  Zero-regression: with no board override this returns exactly 220×160. Pure, never throws. */
export function boardDefaultItemSize(board: AppearanceProfile | undefined): { w: number; h: number } {
  const dim = (key: string, fallback: number): number => {
    // finiteCoord BEFORE the >0 test: a persisted `Number.MAX_VALUE` is finite + positive, so the old
    // `Number.isFinite(v) && v > 0` accepted it → an astronomically large new item. finiteCoord bounds it
    // to a real board coord (non-finite → NaN fallback → the global default). A normal preset is a no-op.
    const v = finiteCoord(Number(resolveAppearanceKey(key, undefined, board)), NaN);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { w: dim('defaultWidth', 220), h: dim('defaultHeight', 160) };
}

/** Resolve a board's SKETCH look into the export contract's DATA opts (font + the named connector
 *  brushstroke + the two independent roughness axes) so a downloaded SVG/PNG matches the on-screen
 *  board — what-you-see-is-what-you-export (cont.26). ONE resolver every export caller shares
 *  (L069/L030): it reads the SAME appearance cascade the live `ConnectorLayer`/`NoteItem` read, so
 *  live and export cannot diverge. Every field is absent-when-off (the named style is omitted when
 *  it is the crisp `solid` default), so a crisp board still exports byte-identically. */
export function boardExportLook(
  board: AppearanceProfile | undefined,
): { fontFamily?: string; connectorStrokeStyle?: string; borderStrokeStyle?: string; connectorRoughness?: number; borderRoughness?: number } {
  const pos = (key: string): number | undefined => {
    const v = Number(resolveAppearanceKey(key, undefined, board));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const named = (key: string): string | undefined => {
    const v = resolveAppearanceKey(key, undefined, board);
    return typeof v === 'string' && v && v !== 'solid' ? v : undefined; // omit the crisp default → byte-identical export
  };
  const font = resolveAppearanceKey('fontFamily', undefined, board);
  return {
    ...(typeof font === 'string' && font ? { fontFamily: font } : {}),
    ...(named('connectorStrokeStyle') !== undefined ? { connectorStrokeStyle: named('connectorStrokeStyle') } : {}),
    ...(named('borderStrokeStyle') !== undefined ? { borderStrokeStyle: named('borderStrokeStyle') } : {}),
    ...(pos('connectorRoughness') !== undefined ? { connectorRoughness: pos('connectorRoughness') } : {}),
    ...(pos('borderRoughness') !== undefined ? { borderRoughness: pos('borderRoughness') } : {}),
  };
}

/** The note-density options offered by the format control, as DATA (label + value) — the same
 *  open-list pattern as SIZE_MODE_OPTIONS. A new density is one row, zero control change. Values
 *  match the `ui` Card `padding` scale so the resolved value passes straight through. */
export const PADDING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'sm', label: 'Compact' },
  { value: 'md', label: 'Cozy' },
  { value: 'lg', label: 'Spacious' },
];

/** Resolve ONE appearance property through the cascade: a non-empty ITEM override wins, else the
 *  BOARD default, else the GLOBAL default. Generic over `key` — the resolver never names a
 *  specific property, so a new appearance key needs zero code here. `itemValue` is the item's
 *  own flat `extra.<key>` (the established self-describing convention: extra.shape, extra.crop…). */
export function resolveAppearanceKey(
  key: string,
  itemValue: unknown,
  board: AppearanceProfile | undefined,
  global: AppearanceProfile = GLOBAL_APPEARANCE,
): unknown {
  if (itemValue !== undefined && itemValue !== null && itemValue !== '') return itemValue;
  // Own-key reads (shared proto-safe SSOT): `board`/`global` are DATA records; a plain `board[key]` would
  // pick up an INHERITED value (an ambient Object.prototype pollution at a real cascade name), yielding a
  // phantom default. `ownValue` restricts to own data, so an unset key cleanly cascades to the next tier.
  const boardVal = board ? ownValue(board, key) : undefined;
  if (boardVal !== undefined && boardVal !== null && boardVal !== '') return boardVal;
  return ownValue(global, key);
}

// ── sizeMode capability map (the first cascade property, dissolving R1) ────────────────────
// How a text item's content relates to its box. An OPEN capability map keyed by DATA (not a
// closed enum): a new mode is one row, zero renderer change. The style is applied to the note's
// content container; `fit` keeps the #217 auto-height behavior (the box grows to the text), so
// only `fit` drives auto-height — `fill`/`scroll` pin the box and let the content fill or scroll.

/** A plain CSS-property bag (no React import — this leaf stays pure). The renderer spreads it. */
export type StyleBag = Record<string, string | number>;

const SIZE_MODE_STYLES: Record<string, StyleBag> = {
  // Auto-height owns the height (#217/#219) — no fixed height, natural flow.
  fit: {},
  // Stretch: the content fills the item's box; overflow is clipped (the box is authoritative).
  fill: { height: '100%', overflow: 'hidden' },
  // Scroll: the box is fixed; content taller than the box scrolls inside it.
  scroll: { height: '100%', overflow: 'auto', minHeight: 0 },
};

/** The content-container style for a size mode. Unknown/absent → `fit` (today's behavior). Own-key
 *  lookup: `mode` is untrusted `extra.sizeMode` — a plain `SIZE_MODE_STYLES[key]` with '__proto__' /
 *  'constructor' returns an inherited object/function (skipping the `?? fit`), not a StyleBag. */
export function sizeModeStyle(mode: unknown): StyleBag {
  const key = typeof mode === 'string' && mode !== '' ? mode : 'fit';
  return ownValue(SIZE_MODE_STYLES, key) ?? SIZE_MODE_STYLES.fit;
}

/** Only the `fit` mode drives auto-height growth (#217); `fill`/`scroll` pin the box, so the renderer
 *  must NOT auto-grow them. Unknown/absent → true (auto-height). This MUST agree with `sizeModeStyle`,
 *  which treats an unknown mode as `fit`: an unknown/future mode gets fit styles, so it must also get
 *  auto-height (else it renders fit-styled yet non-growing — #2). Auto-height iff `fit` OR unknown. */
export function sizeModeIsAutoHeight(mode: unknown): boolean {
  const key = typeof mode === 'string' && mode !== '' ? mode : 'fit';
  return key === 'fit' || ownValue(SIZE_MODE_STYLES, key) === undefined;
}

/** The size modes offered by the format control, as DATA (label + value). NOT a closed union in
 *  the control — the control renders whatever rows this exposes, and new modes drop in here. */
export const SIZE_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'fit', label: 'Fit text' },
  { value: 'fill', label: 'Fill box' },
  { value: 'scroll', label: 'Scroll' },
];

// ── connector-default DATA (R2b) — the SSOT swatches + weight rows shared by BOTH the per-connector
// control (ConnectorFormatControls) and the board-DEFAULT control (BoardBackgroundPicker). One list,
// two controls: the quick swatches and weight stops never drift between "style this line" and "theme
// all my lines". Full color freedom still lives on the wheel; these are only the quick stops (DATA).

/** Quick connector-color swatches under the color wheel. Society DATA — the stored value is a free
 *  hex; a composition root could offer more. Shared by the per-line + board-default color controls. */
export const CONNECTOR_COLOR_PRESETS = ['#6366f1', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#64748b'] as const;

/** The connector line-weight stops offered as labelled DATA (the board-default Dropdown) AND as the
 *  numeric cycle for the per-line weight button (`.map(Number)`). SSOT: adding a weight is one row,
 *  and the two controls stay in lockstep. The STORED value is a free number, not a closed enum. */
export const CONNECTOR_WIDTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: 'Thin' },
  { value: '2', label: 'Regular' },
  { value: '4', label: 'Bold' },
  { value: '6', label: 'Heavy' },
];

// (cont.26) CONNECTOR_ROUGHNESS_OPTIONS (Crisp/Pencil/Sketch) was dissolved into STROKE_STYLE_OPTIONS —
// BOTH the connector `Line style` and the note `Border` texture controls are now the same named-
// brushstroke catalog (L063 symmetry). The raw `connectorRoughness`/`borderRoughness` keys survive only
// as per-line/per-item overrides honored by `resolveStroke`; neither has its own board control anymore.

/** cont.26 Line-style axis — the NAMED brushstroke picker (human labels over the `connectorStrokeStyle`
 *  cascade key). PROJECTED straight from the `STROKE_STYLES` catalog SSOT (do NOT re-list the styles
 *  here — a new brushstroke row in `stroke-style.ts` appears in this control automatically, L090/L030).
 *  One "Line style" pick collapses the old separate roughness (Crisp/Pencil/Sketch) + dashed (Solid/
 *  Dashed) controls: solid/dashed/dotted/pencil/marker/sketch are all ONE selectable line texture. */
export const STROKE_STYLE_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  STROKE_STYLES.map((s) => ({ value: s.id, label: s.label }));

/** cont.26 (E2) — note text font offered as DATA (human labels over the `fontFamily` cascade key
 *  the renderer applies to the card root). Values are real CSS font-family stacks; '' = Default
 *  (system, byte-identical). "Handwritten" is the sketch look. A new font is one row — L090. */
export const FONT_FAMILY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', 'Patrick Hand', cursive", label: 'Handwritten' },
  { value: 'Georgia, Cambria, "Times New Roman", serif', label: 'Serif' },
  { value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', label: 'Mono' },
];

/** The note-container styles offered as DATA (human labels over the `ui` Card `variant` scale the
 *  cascade renderer already reads at `containerVariant`). Values MUST match Card's variants
 *  (surface/elevated/panel/ghost) so the resolved value passes straight through. */
export const CONTAINER_VARIANT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'surface', label: 'Glass' },
  { value: 'elevated', label: 'Card' },
  { value: 'panel', label: 'Panel' },
  { value: 'ghost', label: 'Plain' },
];

/** Board-DEFAULT connector STYLE option DATA (arrow / routing / dashed) — the idle connector style
 *  when a connector has no per-line `extra.arrow`/`routing`/`dashed` (and no relationKind spec). A
 *  deliberate SUBSET of the per-connector control (routing omits `waypoints`, which is per-connector
 *  geometry): a board sets a DEFAULT, an individual line still overrides. Values match `ConnectorLayer`. */
export const CONNECTOR_ARROW_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'end', label: 'Arrow at end' },
  { value: 'both', label: 'Both ends' },
  { value: 'none', label: 'No arrow' },
];
export const CONNECTOR_ROUTING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'straight', label: 'Straight' },
  { value: 'curved', label: 'Curved' },
  { value: 'smooth', label: 'Smooth curve' },
  { value: 'elbow', label: 'Elbow' },
  { value: 'diagonal', label: 'Diagonal (45°)' },
  { value: 'avoid', label: 'Avoid obstacles' },
];
// Board-level line-jumps toggle (draw.io canon) as an on/off select (reuses the select widget — no new
// widget kind). '' → off (the GLOBAL default, zero-regression); 'on' → crossing lines hop with a small arc.
export const CONNECTOR_JUMPS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Off' },
  { value: 'on', label: 'On' },
];
export const CONNECTOR_CORNERS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Sharp' },
  { value: 'round', label: 'Round' },
];
// Content placement presets for the board default (derived from the CONTENT_ANCHORS DATA SSOT). '' = the
// default top-left flow (no placement wrapper, zero regression); the nine named presets map through the
// blind `contentPlacement` leaf. A new preset is one CONTENT_ANCHORS row — this list follows automatically.
export const CONTENT_ANCHOR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Default (top left)' },
  ...CONTENT_ANCHORS.map((a) => ({ value: a.value, label: a.label })),
];
// Board-default PHOTO FILTER options (derived from the BOARD_FILTER_PRESETS DATA SSOT). The catalog's
// `none` preset maps to '' (= the default/inherit no-filter state, matching every other cascade control);
// the rest are the named mood-board looks (B&W/Noir/Sepia/…). A new preset row here follows automatically.
export const PHOTO_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  BOARD_FILTER_PRESETS.map((p) => ({ value: p.id === 'none' ? '' : p.id, label: p.label }));
// (cont.26) The former CONNECTOR_DASHED_OPTIONS + connectorRoughness options were dissolved into the
// single `STROKE_STYLE_OPTIONS` "Line style" control (L063 collapse): solid/dashed/dotted/pencil/marker/
// sketch are one named brushstroke axis now. `connectorDashed` survives only as a per-line raw dash
// override honored by `resolveStroke`; it no longer has its own board control.

// ── board-default CONTROL descriptors (the L069 primitive the hand-written control rows configure) ──
// Every board-default control (Text size, Note density, Connector color/weight …) is the SAME shape:
// a labelled row bound to ONE appearance-cascade key, writing through the ONE generic
// setBoardAppearanceKey(key, value) (blind to what the key means). Rather than hand-write each row
// (instance-solving the category — L063/L067), the rows are DATA: a descriptor names its cascade
// `key`, human `label`, `widget` id, and the widget's DATA (options / presets). A blind
// `BoardDefaultControl` dispatches `widget` through a capability map and renders it — so a NEW
// cascade key's control appears by adding ONE descriptor row here, ZERO renderer/panel/props code
// (this structurally closes the "cascade key resolved+rendered but has no user surface" gap).

/** One board-default control, fully DATA. `widget` selects the blind renderer's capability
 *  ('select' = Dropdown over `options`; 'color' = swatch + wheel over `presets`). `valueKind`
 *  coerces the set value (a weight is stored as a number, not a string) — omitted → string. */
export interface BoardDefaultControlDescriptor {
  key: string;
  label: string;
  widget: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  presets?: readonly string[];
  valueKind?: 'string' | 'number' | 'boolean';
  /** The label to use when this control appears at the PER-ITEM tier (a note's own override), e.g.
   *  'Note style' vs the board-tier 'Note style on this board'. A descriptor WITHOUT an itemLabel is
   *  board-only (connector defaults, new-note footprint) — it never appears in the item picker. This
   *  is the ONE registry projected to both tiers (ITEM_APPEARANCE_CONTROLS filters + relabels). */
  itemLabel?: string;
  /** Bounds for the 'number' widget (DATA, not hardcoded in the widget). A value below `min`/above
   *  `max` is still fail-safed downstream (`boardDefaultItemSize` floors non-positive to the global). */
  min?: number;
  max?: number;
  step?: number;
}

/** b102 — the image-palette toggle values ('' = Off, the unset/default; 'on' = show the swatch strip). */
export const SHOW_PALETTE_OPTIONS = [
  { value: '', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

/** The board-default controls shown in the board-appearance popover, as DATA (SSOT). Each row is a
 *  configuration of the ONE control primitive; adding a control for another cascade key = one row. */
export const BOARD_DEFAULT_CONTROLS: ReadonlyArray<BoardDefaultControlDescriptor> = [
  // `containerVariant` is the EMERGENCE proof (L069): it was already cascade-resolved + rendered
  // (`item-renderers` `Card variant`) but had no granular control — this ONE descriptor row makes a
  // "Note style" control appear with ZERO renderer/panel/props/test code (the DATA row IS the feature).
  { key: 'containerVariant', label: 'Note style on this board', itemLabel: 'Note style', widget: 'select', options: CONTAINER_VARIANT_OPTIONS },
  { key: 'sizeMode', label: 'Text size on this board', itemLabel: 'Text size', widget: 'select', options: SIZE_MODE_OPTIONS },
  { key: 'padding', label: 'Note density on this board', itemLabel: 'Note density', widget: 'select', options: PADDING_OPTIONS },
  // New-note footprint (defaultWidth/defaultHeight) was already cascade-resolved + used at item
  // creation (`boardDefaultItemSize`) with NO control — the last resolved+rendered cascade key
  // without a surface. These two rows close it AND introduce the 'number' widget kind (proving the
  // capability map extends to a new widget, not just new keys), ZERO picker/panel change.
  { key: 'defaultWidth', label: 'New note width', widget: 'number', valueKind: 'number', min: 80, max: 800, step: 10 },
  { key: 'defaultHeight', label: 'New note height', widget: 'number', valueKind: 'number', min: 60, max: 800, step: 10 },
  { key: 'connectorColor', label: 'Connector color', widget: 'color', presets: CONNECTOR_COLOR_PRESETS },
  { key: 'connectorWidth', label: 'Connector weight', widget: 'select', options: CONNECTOR_WIDTH_OPTIONS, valueKind: 'number' },
  // Board-DEFAULT connector STYLE — arrow/routing were `c.arrow ?? 'end'` / `c.routing ?? 'straight'`
  // and dashed was per-connector-only in ConnectorLayer; now board-presettable (per-line still wins).
  { key: 'connectorArrow', label: 'Connector arrows', widget: 'select', options: CONNECTOR_ARROW_OPTIONS },
  { key: 'connectorRouting', label: 'Connector routing', widget: 'select', options: CONNECTOR_ROUTING_OPTIONS },
  // cont.26 Line-style axis (L063 collapse) — ONE board-DEFAULT "Line style" pick replaces the former
  // separate `connectorDashed` (Solid/Dashed) + `connectorRoughness` (Crisp/Pencil/Sketch) controls:
  // solid/dashed/dotted/pencil/marker/sketch are all one selectable brushstroke, resolving to
  // roughness+bowing+dash via `resolveStroke` (per-line `extra.strokeStyle`/`roughness`/`dashed` still win).
  { key: 'connectorStrokeStyle', label: 'Line style', widget: 'select', options: STROKE_STYLE_OPTIONS },
  { key: 'connectorJumps', label: 'Line jumps at crossings', widget: 'select', options: CONNECTOR_JUMPS_OPTIONS },
  { key: 'connectorCorners', label: 'Corner style', widget: 'select', options: CONNECTOR_CORNERS_OPTIONS },
  { key: 'connectorArrowHead', label: 'Arrowhead shape', widget: 'select', options: CONNECTOR_ARROWHEAD_OPTIONS },
  // cont.26 (Line-style for BORDERS) — the note-border texture is now the SAME named-brushstroke axis as
  // connectors (L063 symmetry): ONE "Note border style" pick (solid/dashed/dotted/pencil/marker/sketch)
  // replaces the old Crisp/Pencil/Sketch `borderRoughness` select. Solid = the plain card; dashed/dotted
  // draw a crisp dashed outline (suppressing the card's own border); pencil/marker/sketch bow. Both board
  // and per-item (itemLabel) — per-item `extra.borderStrokeStyle`/`borderRoughness` still win via resolveStroke.
  { key: 'borderStrokeStyle', label: 'Note border style', itemLabel: 'Border', widget: 'select', options: STROKE_STYLE_OPTIONS },
  // Board-DEFAULT bullet marker (R3 marker catalog × R2b cascade): a list/checklist board defaults
  // EVERY note to a glyph (•/✓/★) with a per-item marker still winning (the existing MarkerPicker) and
  // "Default" clearing → no marker (zero-regression, GLOBAL has no marker key). Emerges the moment the
  // renderer resolves `marker` through the cascade — this ONE `select` row (glyph options from the marker
  // SSOT) is the whole board-default surface; per-item stays board-only here (no itemLabel).
  { key: 'marker', label: 'Bullet marker (board default)', widget: 'select', options: MARKER_DEFAULT_OPTIONS },
  // Board-DEFAULT note shape (#155 shape catalog × R2b cascade): a diagram/flowchart board defaults
  // EVERY note to an ellipse/diamond/hexagon; per-item `extra.shape` (the bulk-bar BoardShapeControls)
  // still wins; "Default" clears → rectangle (GLOBAL has no shape key → zero-regression). Second catalog
  // to prove the cascade generalizes (after marker) — ONE select row, board-only (no itemLabel).
  { key: 'shape', label: 'Note shape (board default)', widget: 'select', options: SHAPE_DEFAULT_OPTIONS },
  // cont.26 (E2) — board-DEFAULT note font (per-item `extra.fontFamily` still wins; "Default" clears
  // → system, GLOBAL has no fontFamily key → zero-regression). Applied on the card root by the
  // renderer (RichTextEditor inherits). "Handwritten" is the sketch look. itemLabel → also per-item.
  { key: 'fontFamily', label: 'Note font (board default)', itemLabel: 'Font', widget: 'select', options: FONT_FAMILY_OPTIONS },
  { key: 'contentAnchor', label: 'Text placement (board default)', itemLabel: 'Text placement', widget: 'select', options: CONTENT_ANCHOR_OPTIONS },
  { key: 'elevation', label: 'Card depth (board default)', itemLabel: 'Depth', widget: 'select', options: ELEVATION_LEVELS },
  { key: 'photoFilter', label: 'Image filter (board default)', itemLabel: 'Image filter', widget: 'select', options: PHOTO_FILTER_OPTIONS },
  // b102 — show each image's extracted colour palette (median-cut) as a swatch strip. Board-only (no itemLabel):
  // a mood board turns it on for ALL its images at once; '' = Off (GLOBAL has no key → byte-identical, off by default).
  { key: 'showPalette', label: 'Image colour palette', widget: 'select', options: SHOW_PALETTE_OPTIONS },
];

/** The PER-ITEM appearance controls — the SAME registry projected to the item tier: every descriptor
 *  carrying an `itemLabel` (the note-appearance keys: containerVariant/sizeMode/padding), relabelled
 *  to its item label. A per-item pick writes the note's own `extra.<key>` (winning over the board
 *  default); "Default" clears it (falls back to the board default, then global). Connector defaults +
 *  new-note footprint are board-only (no itemLabel) so they never appear here. Adding a note-appearance
 *  key with an itemLabel surfaces it at BOTH tiers with zero new control code (L063/L069 — ONE primitive,
 *  the same blind BoardDefaultControl renders both). */
export const ITEM_APPEARANCE_CONTROLS: ReadonlyArray<BoardDefaultControlDescriptor> = BOARD_DEFAULT_CONTROLS
  .filter((d) => typeof d.itemLabel === 'string' && d.itemLabel.length > 0)
  .map((d) => ({ ...d, label: d.itemLabel as string }));

/** Read a board's OWN override for a cascade `key` as a control value string ('' when unset, so the
 *  "Default" row is selected). NOT the resolved-through-cascade value — the control shows what THIS
 *  board overrides, not the global fallback. Numbers/booleans stringify; absent/null → ''. */
export function boardDefaultControlValue(board: AppearanceProfile | undefined, key: string): string {
  const raw = board ? ownValue(board, key) : undefined; // own-key: never show an inherited phantom override
  return raw !== undefined && raw !== null ? String(raw) : '';
}

/** Coerce a control's string value back to the stored type for `setBoardAppearanceKey`. '' → undefined
 *  (clears the key → cascade falls back to global); `valueKind:'number'` → Number; else the string. */
export function coerceBoardDefaultValue(value: string, valueKind?: 'string' | 'number' | 'boolean'): unknown {
  if (value === '') return undefined;
  if (valueKind === 'number') return Number(value);
  if (valueKind === 'boolean') return value === 'true';
  return value;
}
