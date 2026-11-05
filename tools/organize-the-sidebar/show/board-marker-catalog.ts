// packages/group/show/board-marker-catalog.ts
//
// The board's catalog of list markers — pure DATA. A marker is whatever string is
// rendered before a list item; an item/list carries the chosen marker id, and a
// blind renderer asks the pure resolver for the exact string to draw before item N.
// Adding a marker is ONE DATA row here — zero resolver code (L069/L090, the #155
// board-shapes catalog pattern applied to list markers). Society DATA in the feature
// package, not the ui engine — the resolver never knows what a marker MEANS.
//
// ENUM DISSOLUTION (L090/enum-dissolution): "the string before item N" is NOT a
// physics-closed binary of {glyph, ordinal} — it is any function of the item's
// position (a fixed char, a numeral, a per-item cycle of emoji, a day-of-week, …).
// So a marker carries a `produce` CAPABILITY ID (data), and `markerTextForIndex`
// DISPATCHES through {@link MARKER_TEXT_PRODUCERS} — it has NO `if (kind === 'glyph')`.
// Adding a new kind of marker (cycle, greek, weekday, …) is ONE producer entry + DATA
// rows, zero change to the resolver. The old closed `kind` union is gone.

import { mergeCatalog } from '../read-data/catalog-merge.ts';

// ---- untrusted-DATA caps (a marker is a bullet — a char/emoji/short ordinal, never a paragraph) ----
// A marker's strings/arrays come from a persisted item (`extra.markerGlyph`/`markerMediaUrl`) or a
// `marker-catalog` published-record — both UNTRUSTED. Uncapped, a megabyte glyph or a million-entry
// glyphs array is emitted into a render cell / scanned whole (render + layout + CPU DoS). Each cap is
// generous headroom for any real marker; past it the value is truncated (fail-safe, never a crash).
const MAX_MARKER_TEXT = 64; // the rendered bullet text (glyph/ordinal/cycle char)
const MAX_MEDIA_URL = 2048; // an image/video bullet URL
const MAX_LABEL = 200; // a picker label
const MAX_GLYPHS = 256; // cycle length
const MAX_OUTLINE_DEPTH = 32; // per-level outline markers actually rendered
/** Truncate an untrusted string to a bound (no-op for any real marker value). */
const capStr = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);

/** One named marker the user picks. `produce` selects the producer capability; the
 *  remaining fields are that producer's config (a glyph char, an ordinal system, a
 *  cycle of glyphs, …). The resolver never enumerates `produce` values. */
export interface BoardMarker {
  /** Stable id stored on the item/list (never the label — labels can change). */
  readonly id: string;
  /** Human label shown in the picker. */
  readonly label: string;
  /** Producer capability id — the key into {@link MARKER_TEXT_PRODUCERS} (data, not enum). */
  readonly produce: string;
  /** For the `glyph` producer — the literal char rendered before every item. */
  readonly glyph?: string;
  /** For the `cycle` producer — the chars rotated per item by `index0 % length`. */
  readonly glyphs?: readonly string[];
  /** For the `image`/`video` producers — the media URL rendered as the marker (a bullet
   *  that is a picture or a clip; a user's "why can't a bullet be an image or a video?"). */
  readonly mediaUrl?: string;
  /** Self-describing capability flag (L090): this marker needs a per-item media URL, so the
   *  picker prompts for one when chosen. The panel reads THIS flag — it never hardcodes which
   *  `produce` kinds are media. Absent → a plain text/glyph marker (no prompt). */
  readonly needsMediaUrl?: boolean;
  /** Self-describing capability flag (L090): this marker needs a per-item GLYPH, so the picker
   *  prompts for any char/emoji when chosen (a user's "whatever they want it to be" — the open,
   *  infinite case the fixed rows can't enumerate). The typed char is stored per-item as
   *  `extra.markerGlyph` and overlaid onto this row's `glyph`. Absent → uses the row's own glyph. */
  readonly needsGlyph?: boolean;
  /** For the `ordinal` producer — the numbering system (see {@link ORDINAL_FORMATTERS}). */
  readonly ordinal?: string;
  /** For roman/alpha ordinals — letter case (default `lower`). */
  readonly ordinalCase?: 'upper' | 'lower';
  /** Appended to an ordinal, e.g. `'.'` → "1.", `')'` → "1)". */
  readonly suffix?: string;
}

/** The starting marker catalog as pure DATA. Order = display order. Adding a
 *  marker = ONE row — the resolver dispatches on `produce` (data), so a new glyph,
 *  a new ordinal-case/suffix variant, or a new per-item cycle needs zero new code. */
export const BOARD_MARKERS: readonly BoardMarker[] = [
  { id: 'disc', label: 'Disc', produce: 'glyph', glyph: '•' },
  { id: 'circle', label: 'Circle', produce: 'glyph', glyph: '◦' },
  { id: 'square', label: 'Square', produce: 'glyph', glyph: '▪' },
  { id: 'dash', label: 'Dash', produce: 'glyph', glyph: '–' },
  { id: 'star', label: 'Star', produce: 'glyph', glyph: '★' },
  { id: 'arrow', label: 'Arrow', produce: 'glyph', glyph: '→' },
  { id: 'check', label: 'Check', produce: 'glyph', glyph: '✓' },
  // Emoji is just a glyph (any unicode char) — no new code, proves the tier is open.
  { id: 'fire', label: 'Fire', produce: 'glyph', glyph: '🔥' },
  { id: 'decimal', label: 'Decimal', produce: 'ordinal', ordinal: 'decimal', suffix: '.' },
  { id: 'roman', label: 'Roman', produce: 'ordinal', ordinal: 'roman', ordinalCase: 'lower', suffix: '.' },
  { id: 'alpha', label: 'Alpha', produce: 'ordinal', ordinal: 'alpha', ordinalCase: 'lower', suffix: '.' },
  { id: 'lower-alpha', label: 'Lower alpha', produce: 'ordinal', ordinal: 'alpha', ordinalCase: 'lower', suffix: ')' },
  // EMERGENT (the dissolution unlocked it for free): a per-item cycle of glyphs.
  { id: 'moon', label: 'Moon phases', produce: 'cycle', glyphs: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'] },
  // Media bullets (a user: "why can't a bullet be an image or a video?"). The row carries the
  // KIND; the URL is per-item DATA (`extra.markerMediaUrl`) overlaid by the renderer — with no
  // URL the cell is empty (fail-closed, never a broken <img>). Same descriptor, media tier.
  { id: 'image', label: 'Image', produce: 'image', needsMediaUrl: true },
  { id: 'video', label: 'Video', produce: 'video', needsMediaUrl: true },
  // CUSTOM (a user's "whatever they want it to be"): the user types ANY char/emoji/symbol as the
  // bullet. The row is a plain `glyph` producer whose glyph is supplied PER ITEM (`extra.markerGlyph`,
  // prompted via `needsGlyph`) — so ♥, ✦, 🌈, →, or any unicode works with ZERO new catalog rows.
  { id: 'custom', label: 'Custom…', produce: 'glyph', needsGlyph: true },
];

/** The board-DEFAULT bullet-marker options (label + value) for the appearance-cascade `marker`
 *  key — the built-in GLYPH markers (disc/dash/check/star/…) as `{value: id, label: '•  Disc'}`
 *  rows for the board-appearance `select`. GLYPH-only on purpose: an ordinal (`1. 2.`) or a
 *  media marker needs per-item ordering/URL, so a BOARD-wide default of those is incoherent — a
 *  board defaulting every note to `•`/`✓`/`★` is the real feature. Derived from {@link BOARD_MARKERS}
 *  (SSOT) so a new glyph marker row auto-appears here with zero edit. Used by `item-appearance`'s
 *  BOARD_DEFAULT_CONTROLS; the "Default" pick in the select clears it → no marker (zero-regression). */
export const MARKER_DEFAULT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = BOARD_MARKERS
  .filter((m) => m.produce === 'glyph' && !m.needsGlyph && !m.needsMediaUrl && typeof m.glyph === 'string')
  .map((m) => ({ value: m.id, label: `${m.glyph}  ${m.label}` }));

/** marker id → a readable region-heading label (glyph + name where a glyph exists, else the name),
 *  derived from {@link BOARD_MARKERS} (SSOT). Used by the "Group by marker" arrangement facet so a
 *  status/checklist board clusters into labelled '✓ Check' / '★ Star' regions. A new marker row auto-
 *  appears here; the '' (no-per-item-marker) bucket is labelled by the facet's own `emptyLabel`. */
export const MARKER_FACET_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BOARD_MARKERS.map((m) => [m.id, typeof m.glyph === 'string' && m.glyph ? `${m.glyph} ${m.label}` : m.label]),
);

/** Resolve a marker id → its DATA row (`undefined` when none/unknown → the caller
 *  renders no marker). Accepts an injected `catalog` (default the built-in {@link BOARD_MARKERS})
 *  so a board can add/override markers from DATA — see {@link readMarkerCatalog}. */
export function markerById(
  id: string | undefined,
  catalog: readonly BoardMarker[] = BOARD_MARKERS,
): BoardMarker | undefined {
  if (!id) return undefined;
  return catalog.find((m) => m.id === id);
}

/** The published-record payload kind that carries user-defined markers (Society DATA). */
export const MARKER_CATALOG_KIND = 'marker-catalog';

/** The classic legal-outline marker cascade by nesting level: `1.` → `a)` → `i.` → `•` → `–`
 *  (all existing catalog ids). Society DATA — a note opts into multi-level numbering by storing
 *  these ids (or its own) as `extra.outlineMarkers`; deeper levels reuse the last. */
export const DEFAULT_OUTLINE_MARKER_IDS: readonly string[] = ['decimal', 'lower-alpha', 'roman', 'disc', 'dash'];

/** Resolve an ordered list of marker ids → their catalog rows (per-level outline markers).
 *  Unknown ids resolve to `undefined` (that level draws no bullet). */
export function resolveLevelMarkers(
  ids: readonly string[],
  catalog: readonly BoardMarker[] = BOARD_MARKERS,
): (BoardMarker | undefined)[] {
  // Cap to a sane nesting depth: `extra.outlineMarkers` is untrusted, and only a handful of levels ever
  // render — a million-entry array would allocate/scan for nothing.
  return (ids.length > MAX_OUTLINE_DEPTH ? ids.slice(0, MAX_OUTLINE_DEPTH) : ids).map((id) => markerById(id, catalog));
}

/** Read one BoardMarker row from an untrusted DATA object — keeping only well-formed rows
 *  (id/label/produce required; the rest are the producer's optional config, copied verbatim).
 *  The producer is DATA (`produce` id), so a DATA row can use ANY existing producer — glyph,
 *  ordinal, cycle, image, video — with ZERO code here (L090). Returns `null` if malformed. */
function markerFromData(row: Record<string, unknown>): BoardMarker | null {
  if (typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.produce !== 'string') return null;
  // Cap every stored string — an unbounded id/label/produce from an untrusted marker-catalog row would be
  // scanned/rendered whole later. Generous for any real marker; abuse is truncated, not accepted whole.
  const marker: BoardMarker = { id: capStr(row.id, MAX_LABEL), label: capStr(row.label, MAX_LABEL), produce: capStr(row.produce, MAX_LABEL) };
  const isStr = (v: unknown): v is string => typeof v === 'string';
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const optStr = (k: string, max: number): Partial<Record<string, string>> =>
    isStr(row[k]) ? { [k]: capStr(row[k] as string, max) } : {};
  const optBool = (k: string): Partial<Record<string, boolean>> => (isBool(row[k]) ? { [k]: row[k] as boolean } : {});
  return {
    ...marker,
    ...optStr('glyph', MAX_MARKER_TEXT),
    // Cap the glyphs array BEFORE `.every` — a hostile million-entry array would otherwise be scanned whole.
    ...(Array.isArray(row.glyphs) && row.glyphs.slice(0, MAX_GLYPHS).every(isStr)
      ? { glyphs: (row.glyphs as string[]).slice(0, MAX_GLYPHS).map((g) => capStr(g, MAX_MARKER_TEXT)) }
      : {}),
    ...optStr('mediaUrl', MAX_MEDIA_URL),
    ...optBool('needsMediaUrl'),
    ...optBool('needsGlyph'),
    ...optStr('ordinal', MAX_LABEL),
    ...(row.ordinalCase === 'upper' || row.ordinalCase === 'lower' ? { ordinalCase: row.ordinalCase } : {}),
    ...optStr('suffix', MAX_MARKER_TEXT),
  };
}

/**
 * The board's EFFECTIVE marker catalog = the built-in {@link BOARD_MARKERS} plus any
 * user-defined markers from `marker-catalog` published-records (Society DATA), so "which
 * markers exist" is DATA, not a source const (L090/Physics-vs-Society — mirrors
 * `readArrangementLensCatalog`/`readInspectionFieldSets`). A DATA row whose `id` matches a
 * built-in OVERRIDES it in place; a new `id` is appended. The producers (Physics) stay in
 * code — a DATA row only picks a producer + its config. Adding/redefining a marker is one
 * DATA row, zero code.
 */
export function readMarkerCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): BoardMarker[] {
  return mergeCatalog(records, {
    kind: MARKER_CATALOG_KIND,
    arrayKey: 'markers',
    idOf: (m) => m.id,
    parseRow: markerFromData,
    builtins: BOARD_MARKERS,
  });
}

/** Roman numeral for `n` in 1..3999 (subtractive form: i,iv,ix,xl,xc,cd,cm,m…),
 *  lowercase. Returns `''` outside the representable range (never throws). */
function toRoman(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 3999) return '';
  const table: ReadonlyArray<readonly [number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let value = Math.floor(n);
  let out = '';
  for (const [amount, symbol] of table) {
    while (value >= amount) {
      out += symbol;
      value -= amount;
    }
  }
  return out;
}

/** Bijective base-26 letters for `n` in 1..∞ (1→a, 26→z, 27→aa, 28→ab…),
 *  lowercase. Returns `''` for n < 1 (never throws). */
function toAlpha(n: number): string {
  if (!Number.isFinite(n) || n < 1) return '';
  let value = Math.floor(n);
  let out = '';
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

/** The numbering-system capability map (L090/enum-dissolution): ordinal id → a pure
 *  formatter of the 1-based position. The `ordinal` producer DISPATCHES through this
 *  map — it has no `switch (ordinal)`. Adding a numbering system (greek, hex, …) is
 *  ONE entry here, zero change to any resolver. Unknown ordinal → not in the map → ''. */
export const ORDINAL_FORMATTERS: Readonly<Record<string, (n: number) => string>> = {
  decimal: (n) => String(n),
  roman: (n) => toRoman(n),
  alpha: (n) => toAlpha(n),
};

/** A marker CELL: the self-describing renderable a marker produces before item N. Text
 *  markers set `text`; media markers (image/video) set `mediaUrl` + `mediaType`. The blind
 *  renderer dispatches on WHICH field is present — so "a bullet can be a char, a number, an
 *  emoji, an image, or a video" is ONE descriptor, not five code paths (L090/L069). An empty
 *  cell `{}` = no marker. */
export interface MarkerCell {
  /** A text marker (glyph/emoji/ordinal/cycle). */
  readonly text?: string;
  /** A media marker's source URL (an image or video used AS the bullet). */
  readonly mediaUrl?: string;
  /** The media kind — the renderer picks img/video by content (L090); never enumerated here. */
  readonly mediaType?: string;
}

/** A marker cell producer: given the marker DATA and a 0-based item index, return the
 *  {@link MarkerCell} to render before that item. Pure, deterministic, never throws. */
export type MarkerCellProducer = (marker: BoardMarker, index0: number) => MarkerCell;

/** The marker producer capability map (L090/enum-dissolution) — `produce` id → producer.
 *  This dissolves the old closed `kind: 'glyph' | 'ordinal'` union AND the text-vs-media
 *  boundary: "the thing before item N" is any function of position producing any renderable,
 *  so each shape is a DATA-keyed producer, not a resolver branch. Adding a marker kind
 *  (weekday, greek, image, video, checkbox-state, …) is ONE entry here + DATA rows —
 *  {@link markerCellForIndex} never changes. Unknown `produce` → empty cell. */
export const MARKER_CELL_PRODUCERS: Readonly<Record<string, MarkerCellProducer>> = {
  /** Fixed char for every item (index-independent). Emoji is just a glyph char. The rendered text is
   *  length-capped: `m.glyph` can be a per-item `extra.markerGlyph` overlay (untrusted), so a megabyte
   *  "glyph" would otherwise be emitted straight into a render cell (layout/CPU DoS). */
  glyph: (m) => ({ text: capStr(m.glyph ?? '', MAX_MARKER_TEXT) }),
  /** Per-item rotation over `glyphs` by `index0 % length` (moon phases, day dots, …). */
  cycle: (m, i) => {
    const g = m.glyphs;
    if (!g || g.length === 0) return {};
    const n = Math.floor(i);
    return { text: capStr(g[((n % g.length) + g.length) % g.length] ?? '', MAX_MARKER_TEXT) };
  },
  /** Numbering system formatted from the 1-based position, cased, with an optional suffix. */
  ordinal: (m, i) => {
    // Own-key lookup only: `m.ordinal` is untrusted DATA (a marker-catalog row). `ORDINAL_FORMATTERS['__proto__']`
    // would resolve to Object.prototype (not a function → crash on the call below); 'constructor' → Object.
    const format =
      m.ordinal && Object.prototype.hasOwnProperty.call(ORDINAL_FORMATTERS, m.ordinal) ? ORDINAL_FORMATTERS[m.ordinal] : undefined;
    if (!format) return {};
    const body = format(Math.floor(i) + 1);
    if (body === '') return {};
    const cased = m.ordinalCase === 'upper' ? body.toUpperCase() : body;
    return { text: capStr(cased + (m.suffix ?? ''), MAX_MARKER_TEXT) };
  },
  /** An image used AS the bullet (a user's "why can't a bullet be an image?"). The mediaType is
   *  a MIME PREFIX so MediaFrame dispatches <img>/<video> by `startsWith('image/'|'video/')`. The URL is
   *  length-capped (a per-item `extra.markerMediaUrl` overlay is untrusted). */
  image: (m) => (m.mediaUrl ? { mediaUrl: capStr(m.mediaUrl, MAX_MEDIA_URL), mediaType: 'image/*' } : {}),
  /** A video used AS the bullet. */
  video: (m) => (m.mediaUrl ? { mediaUrl: capStr(m.mediaUrl, MAX_MEDIA_URL), mediaType: 'video/*' } : {}),
};

/** The pure resolver — given a marker and a 0-based item index, return the {@link MarkerCell}
 *  to render before the item, by DISPATCHING through the injected producer map (default
 *  {@link MARKER_CELL_PRODUCERS}). No `if (kind === …)` — the discriminant is DATA.
 *  Unknown/undefined marker or unknown `produce` → `{}` (safe, never throws). Adding a
 *  marker kind never touches this function (L090). */
export function markerCellForIndex(
  marker: BoardMarker | undefined,
  index0: number,
  producers: Readonly<Record<string, MarkerCellProducer>> = MARKER_CELL_PRODUCERS,
): MarkerCell {
  if (!marker) return {};
  // Own-key lookup only: `marker.produce` is untrusted DATA (a marker-catalog published-record row).
  // `producers['__proto__']` would resolve to Object.prototype (not a function → crash when called);
  // `producers['constructor']` → Object (callable) → returns the marker as a fake cell. hasOwn + a
  // function check fail closed to an empty cell (no marker) for any prototype-chain `produce`.
  const produce = Object.prototype.hasOwnProperty.call(producers, marker.produce) ? producers[marker.produce] : undefined;
  return typeof produce === 'function' ? produce(marker, index0) : {};
}

/** Back-compat text projection of {@link markerCellForIndex} — the plain-text of a marker
 *  cell (media markers project to `''`). Used by the picker label preview and any text-only
 *  caller. Deterministic, never throws. */
export function markerTextForIndex(
  marker: BoardMarker | undefined,
  index0: number,
  producers: Readonly<Record<string, MarkerCellProducer>> = MARKER_CELL_PRODUCERS,
): string {
  return markerCellForIndex(marker, index0, producers).text ?? '';
}
