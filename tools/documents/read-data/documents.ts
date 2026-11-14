import type { ComponentDefinitionRecord } from './resolve-component-instances';
import { activeTokenAt, type InlineMark } from 'trillion-workshop/tools/edit-a-document-together/read-data/inline-tokens.ts';

export type CanvasCamera = {
  pan_x: number;
  pan_y: number;
  zoom: number;
};

// Base dot-grid cell size in WORLD pixels (the screen size at zoom = 1). The grid
// scales WITH the content under zoom (canvasGridSize), so one world cell is always
// the same distance in world space — the canvas reads as one rigid infinite plane.
export const CANVAS_GRID_BASE_PX = 24;

// World-anchored dot-grid OFFSET. The host applies the camera as a VIEW TRANSFORM
// over the engine's world-coordinate frames (the engine itself does NOT project
// frames — it stores the camera and only culls visibility; verified mod.rs:2240,
// Codex-converged 2026-06-23). So the host adopts the ENGINE camera convention
// (composition-ast types.rs:671 `world_to_screen`): screen = world * zoom + pan,
// pan in SCREEN pixels. The dot grid is painted on the FIXED stage (it does not
// transform), so to stay locked to the content plane it shifts by +pan (world 0
// sits at screen `pan`). Pure string (no React/DOM dep) so the surface applies it
// blindly as `backgroundPosition` and the rule stays unit-testable. Mirrors the
// content-plane `transform: translate(pan) scale(zoom)` exactly, so grid + frames
// move and scale together. (Negating pan here — the old `screen = world - pan`
// host convention — would desync the grid from the engine's culling and the
// frames the moment pan ≠ 0.)
export function canvasGridPosition(camera: CanvasCamera | null | undefined): string {
  const panX = camera?.pan_x ?? 0;
  const panY = camera?.pan_y ?? 0;
  return `${panX}px ${panY}px`;
}

// World-anchored dot-grid CELL SIZE under zoom: a world cell of CANVAS_GRID_BASE_PX
// renders at base * zoom screen pixels, so the grid scales in lockstep with the
// content-plane `scale(zoom)`. Floored at a hair > 0 so an extreme zoom-out can
// never collapse the background-size to 0 (browsers ignore a 0 size). Pure string.
export function canvasGridSize(
  camera: CanvasCamera | null | undefined,
  basePx: number = CANVAS_GRID_BASE_PX,
): string {
  const zoom = camera?.zoom && camera.zoom > 0 ? camera.zoom : 1;
  const cell = Math.max(2, basePx * zoom);
  return `${cell}px ${cell}px`;
}

// The engine lays out into whatever VIEWPORT it is handed. So the single property
// that makes "content overflows the available area" structurally impossible is:
// hand the engine the stage's REAL pixel size, never a fixed desktop design size.
// That one property fixes the whole CATEGORY at once (phone, tablet, split-pane,
// embedded small frame, ultrawide) — not one breakpoint (L063). The engine stays
// the only layout truth; the surface measures the stage and reports the size, the
// engine reflows. Pure (no DOM dep) so this size-normalization stays unit-testable.
export type Viewport = { w: number; h: number };

// Fallback used ONLY before the stage has been measured (first paint, or a hidden /
// zero-size stage). Once the ResizeObserver reports a real size, the real size wins.
// A comfortable desktop authoring width so the pre-measure frame looks right on the
// common (desktop) case.
export const DEFAULT_VIEWPORT: Viewport = { w: 1120, h: 680 };

// Floor: a transiently tiny or zero measurement (collapsed flex mid-animation, a
// detached node) must never starve the engine into a degenerate ~0-width layout.
export const MIN_STAGE_VIEWPORT: Viewport = { w: 280, h: 320 };

// Normalize a raw (clientWidth, clientHeight) measurement into the viewport handed
// to the engine: round to whole pixels, clamp to the floor, and fall back to the
// desktop default when the measurement is absent/zero/NaN (unmounted or hidden
// stage). This is the ONLY place the size input is shaped — the engine does ALL
// layout from it.
export function resolveStageViewport(width: number, height: number): Viewport {
  const w = Math.round(width);
  const h = Math.round(height);
  return {
    w: Number.isFinite(w) && w > 0 ? Math.max(MIN_STAGE_VIEWPORT.w, w) : DEFAULT_VIEWPORT.w,
    h: Number.isFinite(h) && h > 0 ? Math.max(MIN_STAGE_VIEWPORT.h, h) : DEFAULT_VIEWPORT.h,
  };
}

// ── Text formatting: a generic, data-driven style-transform primitive (L069) ───
// The engine ALREADY renders font_size/font_weight/font_style/text_align from a
// node's `style` (sceneStyleToCss), so formatting is pure authoring — a FORMAT
// DESCRIPTOR is DATA describing how to transform the focused node's style, applied
// via the SAME UPDATE_PROPS path as any edit. There is NO H1/H2/Bold enum and NO
// set-vs-toggle mode switch: a descriptor is an ORDERED list of (optional predicate
// → style patch) RULES. The first rule whose `when` matches the node's CURRENT style
// applies; a rule with no `when` is the fallback. So SET = one fallback rule; TOGGLE
// = a matched "on→off" rule + a fallback "on" rule; CYCLE = N chained rules — all the
// SAME primitive, zero new code. Adding/removing/reordering a format is a DATA edit.
// Pure (no DOM/React) so the bar renders blindly and every rule stays unit-testable.
export type StylePatch = Record<string, unknown>;

// A generic, composable predicate over a node's CURRENT style — the SAME algebra
// gates both a rule's `when` and a descriptor's `active` highlight. Leaf forms are
// scalar equality and key existence; `all`/`any`/`not` compose them. This closes the
// L069 adversarial gap: a multi-prop format (e.g. a "Code" toggle = mono font AND a
// tint) detects on/off as DATA (`all: [...]`), no special case. Recursive + pure.
export type FormatPredicate =
  | { prop: string; equals: unknown }
  | { prop: string; exists: boolean }
  | { all: FormatPredicate[] }
  | { any: FormatPredicate[] }
  | { not: FormatPredicate };

export function evalFormatPredicate(style: StylePatch | undefined, predicate: FormatPredicate): boolean {
  const s = style ?? {};
  if ('all' in predicate) return predicate.all.every((p) => evalFormatPredicate(s, p));
  if ('any' in predicate) return predicate.any.some((p) => evalFormatPredicate(s, p));
  if ('not' in predicate) return !evalFormatPredicate(s, predicate.not);
  if ('exists' in predicate) return (s[predicate.prop] !== undefined) === predicate.exists;
  return s[predicate.prop] === predicate.equals;
}

export type FormatRule = {
  // Match against the node's CURRENT style; omitted = the fallback (always matches).
  // A fallback short-circuits every rule after it, so it is only valid LAST
  // (enforced by isFormatDescriptorValid).
  when?: FormatPredicate;
  set?: StylePatch;   // props to MERGE onto the style
  unset?: string[];   // props to DELETE — lets a descriptor express "Clear formatting"
};
export type FormatDescriptor = {
  scope?: "block" | "selection";
  id: string;
  label: string;
  icon?: string;
  group?: string;
  // A color chip (any CSS color). When present, the renderer shows this descriptor as a
  // colour SWATCH instead of a text button — and a group whose descriptors carry `swatch`
  // renders as a popover of swatches (presentation selected by DATA, not by group name).
  swatch?: string;
  rules: FormatRule[];
  // The node "has" this format when its current style satisfies this predicate.
  // Drives the active highlight — same generic algebra as `when` (no second engine).
  active?: FormatPredicate;
};

// Apply a descriptor to a node's current style → the next style. The FIRST rule whose
// `when` matches (or the fallback) applies: merge `set`, then delete `unset` keys. If
// nothing matches and there is NO fallback, the style is returned UNCHANGED (never
// force the last rule — that was the pre-convergence bug). Pure: never touches the engine.
export function applyFormatToStyle(currentStyle: StylePatch | undefined, descriptor: FormatDescriptor): StylePatch {
  const style: StylePatch = { ...(currentStyle ?? {}) };
  const rule = descriptor.rules.find((r) => !r.when || evalFormatPredicate(style, r.when));
  if (!rule) return style;
  const next: StylePatch = { ...style, ...(rule.set ?? {}) };
  for (const key of rule.unset ?? []) delete next[key];
  return next;
}

// Is this descriptor's effect currently applied to the node's style? (active highlight)
export function isFormatActive(currentStyle: StylePatch | undefined, descriptor: FormatDescriptor): boolean {
  return !!descriptor.active && evalFormatPredicate(currentStyle ?? {}, descriptor.active);
}

// CSS `text-decoration-line` is ONE property holding a LIST, so underline and
// strikethrough live as INDEPENDENT boolean style flags (text_underline / text_strike).
// This is the SINGLE place that combines them into the CSS value (the host maps the
// result onto the element); all four states fall out — neither → undefined, one → its
// keyword, both → "underline line-through". Pure, so it is unit-locked here and the host
// stays a blind consumer (the format DATA carries two clean independent toggles).
export function textDecorationLine(style: StylePatch | undefined): string | undefined {
  const s = style ?? {};
  const lines: string[] = [];
  if (s.text_underline === true) lines.push('underline');
  if (s.text_strike === true) lines.push('line-through');
  return lines.length ? lines.join(' ') : undefined;
}

// ── Numeric box-spacing editor (the generic numeric-style-field primitive) ───
//
// A spacing edit writes a NUMBER into a style path the ENGINE honors. We verified
// the engine's layout kernel (composition-engine-core/src/kernel/layout.rs): it
// reads `padding` insets (inside a node), `layout.gap` (uniform space BETWEEN a
// flow/split container's children), AND `margin` (space AROUND a node in its parent's
// flow — before/after on the main axis, inset on the cross axis; place_flow_children).
// So this editor exposes all three. `margin` is the PER-BLOCK spacing the user asked
// for: a custom amount of room around ONE block (e.g. more space above a heading),
// distinct from padding (inside) and the uniform parent gap. It is real, engine-honored,
// and per-node — NOT a hardcoded gap and NOT the dead control the old comment claimed.
//
// Each editable field is self-describing DATA: {label, path, min/max/step}. The
// editor is BLIND — it reads/writes whatever fields it is handed, so adding "border
// radius" or "border width" later (both engine-read) is ONE row here, ZERO editor
// code (L069 primitive / L090 self-describing). `path` is an ARRAY of keys
// (machine-readable, not a dotted string) so a dumb consumer descends with no
// string parsing.
export type NumericStyleField = {
  id: string;
  label: string;
  /** Path into a node's `props.style`, e.g. ['padding','top'] or ['layout','gap']. */
  path: string[];
  /** Fields sharing a `group` render together (and a 4-side group links as one). */
  group: string;
  min?: number;
  max?: number;
  step?: number;
};

// Read the number at a style path (missing / non-number → undefined). Pure.
export function readStyleNumber(style: StylePatch | undefined, path: string[]): number | undefined {
  let cursor: unknown = style;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

// Immutably set a number at a style path, creating intermediate records and
// PRESERVING siblings (writing ['layout','gap'] keeps layout.mode/axis). Pure.
export function writeStyleNumber(style: StylePatch | undefined, path: string[], value: number): StylePatch {
  const next: StylePatch = { ...(style ?? {}) };
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    next[head] = value;
    return next;
  }
  const child = isRecord(next[head]) ? (next[head] as StylePatch) : {};
  next[head] = writeStyleNumber(child, rest, value);
  return next;
}

// Built-in spacing field set (DATA). Padding (4 sides, any node) + the flow gap
// labeled in USER language ("Space between blocks" — the thing the owner found "too
// little", which IS the parent gap, not a per-block margin). The editor renders
// whatever this carries; a package could override it from the live store.
export const SPACING_FIELDS: NumericStyleField[] = [
  { id: 'pad-top', label: 'Top', path: ['padding', 'top'], group: 'Padding', min: 0, max: 240, step: 2 },
  { id: 'pad-right', label: 'Right', path: ['padding', 'right'], group: 'Padding', min: 0, max: 240, step: 2 },
  { id: 'pad-bottom', label: 'Bottom', path: ['padding', 'bottom'], group: 'Padding', min: 0, max: 240, step: 2 },
  { id: 'pad-left', label: 'Left', path: ['padding', 'left'], group: 'Padding', min: 0, max: 240, step: 2 },
  // Per-block MARGIN (space AROUND this block, engine-honored). 4 sides so a block can
  // get custom room above/below (or beside) it — the per-block spacing control. Renders
  // as a linkable 4-side group like Padding; unlink to set just "space above/below".
  { id: 'mar-top', label: 'Top', path: ['margin', 'top'], group: 'Margin', min: 0, max: 240, step: 2 },
  { id: 'mar-right', label: 'Right', path: ['margin', 'right'], group: 'Margin', min: 0, max: 240, step: 2 },
  { id: 'mar-bottom', label: 'Bottom', path: ['margin', 'bottom'], group: 'Margin', min: 0, max: 240, step: 2 },
  { id: 'mar-left', label: 'Left', path: ['margin', 'left'], group: 'Margin', min: 0, max: 240, step: 2 },
  { id: 'gap', label: 'Space between blocks', path: ['layout', 'gap'], group: 'Spacing', min: 0, max: 160, step: 2 },
];

// Filter the field set to the ones that MEAN something for THIS node (L116 honesty —
// never offer a control that does nothing). Padding affects any node; gap (a
// `layout.*` field) only matters when there are ≥2 children to space apart. A pure
// function of the node shape — no Society type, no node-kind allow-list beyond the
// child-count physics that the engine itself uses.
export function spacingFieldsForNode(node: SceneNode | null, fields: NumericStyleField[]): NumericStyleField[] {
  if (!node) return [];
  const childCount = node.children?.length ?? 0;
  return fields.filter((field) => (field.path[0] === 'layout' ? childCount >= 2 : true));
}

// Live-overridable field set (same shape as readFormatDescriptors): a package may
// ship its own numeric-style fields; falls back to the built-ins. Generic — never
// names padding/gap, just validates {id,label,path[]} rows.
export function readSpacingFields(raw: unknown): NumericStyleField[] {
  if (!Array.isArray(raw)) return SPACING_FIELDS;
  const fields = raw
    .map(numericStyleFieldFrom)
    .filter((field): field is NumericStyleField => field !== null);
  return fields.length ? fields : SPACING_FIELDS;
}

function numericStyleFieldFrom(value: unknown): NumericStyleField | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const label = typeof value.label === 'string' ? value.label : null;
  const group = typeof value.group === 'string' ? value.group : null;
  const path = Array.isArray(value.path) && value.path.every((k) => typeof k === 'string')
    ? (value.path as string[])
    : null;
  if (!id || !label || !group || !path || path.length === 0) return null;
  const field: NumericStyleField = { id, label, group, path };
  if (typeof value.min === 'number') field.min = value.min;
  if (typeof value.max === 'number') field.max = value.max;
  if (typeof value.step === 'number') field.step = value.step;
  return field;
}

// Built-in format set (DATA). The renderer never names a format — it shows whatever
// descriptors this carries, grouped by `group`. Adding a format (a new heading level,
// an underline, a highlight, a 3-way align cycle) is a row here; later movable to the
// live material store with zero renderer change.
//
// Inline-code look (DATA): a mono stack + a neutral translucent fill. Defined once so the
// code descriptor's SET rule and its active predicate can never drift (SSOT).
const CODE_FONT = 'var(--font-mono)';
const CODE_BG = 'rgba(135,131,120,0.22)';

export const FORMAT_DESCRIPTORS: FormatDescriptor[] = [
  { id: 'fmt:h1', scope: "block", label: 'Heading 1', icon: 'H1', group: 'Style',
    rules: [{ set: { font_size: 30, font_weight: 700 } }], active: { prop: 'font_size', equals: 30 } },
  { id: 'fmt:h2', scope: "block", label: 'Heading 2', icon: 'H2', group: 'Style',
    rules: [{ set: { font_size: 22, font_weight: 600 } }], active: { prop: 'font_size', equals: 22 } },
  { id: 'fmt:body', scope: "block", label: 'Body', icon: '¶', group: 'Style',
    rules: [{ set: { font_size: 16, font_weight: 400 } }], active: { prop: 'font_size', equals: 16 } },
  { id: 'fmt:bold', label: 'Bold', icon: 'B', group: 'Emphasis',
    rules: [{ when: { prop: 'font_weight', equals: 700 }, set: { font_weight: 400 } }, { set: { font_weight: 700 } }],
    active: { prop: 'font_weight', equals: 700 } },
  { id: 'fmt:italic', label: 'Italic', icon: 'I', group: 'Emphasis',
    rules: [{ when: { prop: 'font_style', equals: 'italic' }, set: { font_style: 'normal' } }, { set: { font_style: 'italic' } }],
    active: { prop: 'font_style', equals: 'italic' } },
  // Underline + Strikethrough — INDEPENDENT bool flags the host combines into one CSS
  // `text-decoration-line` (so both can apply at once). Each is a plain TOGGLE: on → set
  // the flag, on-again → unset it (clean style object; no lingering `false`).
  { id: 'fmt:underline', label: 'Underline', icon: 'U', group: 'Emphasis',
    rules: [{ when: { prop: 'text_underline', equals: true }, unset: ['text_underline'] }, { set: { text_underline: true } }],
    active: { prop: 'text_underline', equals: true } },
  { id: 'fmt:strike', label: 'Strikethrough', icon: 'S', group: 'Emphasis',
    rules: [{ when: { prop: 'text_strike', equals: true }, unset: ['text_strike'] }, { set: { text_strike: true } }],
    active: { prop: 'text_strike', equals: true } },
  // Inline code — a MULTI-PROP toggle (mono font + tint applied/removed as a unit). The
  // `all` predicate detects on/off across BOTH props (the L069 multi-prop case); composes
  // freely with bold/italic/underline (disjoint style props).
  { id: 'fmt:code', label: 'Code', icon: '<>', group: 'Emphasis',
    rules: [
      { when: { all: [{ prop: 'font_family', equals: CODE_FONT }, { prop: 'background', equals: CODE_BG }] },
        unset: ['font_family', 'background'] },
      { set: { font_family: CODE_FONT, background: CODE_BG } },
    ],
    active: { all: [{ prop: 'font_family', equals: CODE_FONT }, { prop: 'background', equals: CODE_BG }] } },
  { id: 'fmt:align-left', scope: "block", label: 'Align left', icon: '⇤', group: 'Align',
    rules: [{ set: { text_align: 'left' } }], active: { prop: 'text_align', equals: 'left' } },
  { id: 'fmt:align-center', scope: "block", label: 'Align center', icon: '↔', group: 'Align',
    rules: [{ set: { text_align: 'center' } }], active: { prop: 'text_align', equals: 'center' } },
  { id: 'fmt:align-right', scope: "block", label: 'Align right', icon: '⇥', group: 'Align',
    rules: [{ set: { text_align: 'right' } }], active: { prop: 'text_align', equals: 'right' } },
  { id: 'fmt:align-justify', scope: "block", label: 'Justify', icon: '≡', group: 'Align',
    rules: [{ set: { text_align: 'justify' } }], active: { prop: 'text_align', equals: 'justify' } },
  // Text colour — swatch descriptors (carry `swatch`, so the bar shows the 'Text color'
  // group as a popover of chips, not inline buttons). Each SETs `color`; "Default" UNSETs
  // it (active iff no colour set). Same primitive — a colour is just another descriptor.
  { id: 'fmt:color-default', label: 'Default', group: 'Text color', swatch: '#d4d4d4',
    rules: [{ unset: ['color'] }], active: { prop: 'color', exists: false } },
  { id: 'fmt:color-gray', label: 'Gray', group: 'Text color', swatch: '#9b9b9b',
    rules: [{ set: { color: '#9b9b9b' } }], active: { prop: 'color', equals: '#9b9b9b' } },
  { id: 'fmt:color-red', label: 'Red', group: 'Text color', swatch: '#e03e3e',
    rules: [{ set: { color: '#e03e3e' } }], active: { prop: 'color', equals: '#e03e3e' } },
  { id: 'fmt:color-orange', label: 'Orange', group: 'Text color', swatch: '#d9730d',
    rules: [{ set: { color: '#d9730d' } }], active: { prop: 'color', equals: '#d9730d' } },
  { id: 'fmt:color-yellow', label: 'Yellow', group: 'Text color', swatch: '#dfab01',
    rules: [{ set: { color: '#dfab01' } }], active: { prop: 'color', equals: '#dfab01' } },
  { id: 'fmt:color-green', label: 'Green', group: 'Text color', swatch: '#0f9960',
    rules: [{ set: { color: '#0f9960' } }], active: { prop: 'color', equals: '#0f9960' } },
  { id: 'fmt:color-blue', label: 'Blue', group: 'Text color', swatch: '#0b6bcb',
    rules: [{ set: { color: '#0b6bcb' } }], active: { prop: 'color', equals: '#0b6bcb' } },
  { id: 'fmt:color-purple', label: 'Purple', group: 'Text color', swatch: '#6940a5',
    rules: [{ set: { color: '#6940a5' } }], active: { prop: 'color', equals: '#6940a5' } },
  { id: 'fmt:color-pink', label: 'Pink', group: 'Text color', swatch: '#ad1a72',
    rules: [{ set: { color: '#ad1a72' } }], active: { prop: 'color', equals: '#ad1a72' } },
  // Highlight — swatch descriptors that SET a DISTINCT `highlight` prop (NOT `background`,
  // which inline code owns). The host maps `highlight` onto the element background with
  // precedence over a code tint, so code (font_family + background) and highlight
  // (highlight) are DISJOINT and COMPOSE — no "half-code" state when both apply (Codex
  // convergence). "None" UNSETs `highlight`. Translucent tints that read on any theme.
  { id: 'fmt:hl-none', label: 'No highlight', group: 'Highlight', swatch: '#3a3a3a',
    rules: [{ unset: ['highlight'] }], active: { prop: 'highlight', exists: false } },
  { id: 'fmt:hl-yellow', label: 'Yellow highlight', group: 'Highlight', swatch: 'rgba(255,212,0,0.30)',
    rules: [{ set: { highlight: 'rgba(255,212,0,0.30)' } }], active: { prop: 'highlight', equals: 'rgba(255,212,0,0.30)' } },
  { id: 'fmt:hl-green', label: 'Green highlight', group: 'Highlight', swatch: 'rgba(15,153,96,0.30)',
    rules: [{ set: { highlight: 'rgba(15,153,96,0.30)' } }], active: { prop: 'highlight', equals: 'rgba(15,153,96,0.30)' } },
  { id: 'fmt:hl-blue', label: 'Blue highlight', group: 'Highlight', swatch: 'rgba(11,107,203,0.30)',
    rules: [{ set: { highlight: 'rgba(11,107,203,0.30)' } }], active: { prop: 'highlight', equals: 'rgba(11,107,203,0.30)' } },
  { id: 'fmt:hl-pink', label: 'Pink highlight', group: 'Highlight', swatch: 'rgba(173,26,114,0.30)',
    rules: [{ set: { highlight: 'rgba(173,26,114,0.30)' } }], active: { prop: 'highlight', equals: 'rgba(173,26,114,0.30)' } },
  // "Clear formatting" — a single fallback rule that UNSETS every styled prop, returning
  // the node to engine defaults. Proves the `unset` patch op end-to-end; impossible under
  // merge-only (the pre-convergence shape could only overwrite, never delete). Covers
  // every format prop above (incl. underline/strike/code) so one tap truly resets.
  { id: 'fmt:clear', label: 'Clear formatting', icon: '⌫', group: 'Clear',
    rules: [{ unset: ['font_size', 'font_weight', 'font_style', 'text_align', 'text_underline', 'text_strike', 'font_family', 'background', 'color', 'highlight'] }],
    active: { any: [
      { prop: 'font_size', exists: true }, { prop: 'font_weight', exists: true },
      { prop: 'font_style', exists: true }, { prop: 'text_align', exists: true },
      { prop: 'text_underline', exists: true }, { prop: 'text_strike', exists: true },
      { prop: 'font_family', exists: true }, { prop: 'background', exists: true },
      { prop: 'color', exists: true }, { prop: 'highlight', exists: true },
    ] } },
];

// A descriptor is well-formed iff it has a non-empty rules list AND at most its LAST
// rule is a fallback — a rule with no `when` always matches, short-circuiting every
// rule after it, so a missing predicate is only valid in the final position. This is
// the rule invariant the apply-path relies on; the reader drops rows that violate it.
export function isFormatDescriptorValid(descriptor: FormatDescriptor): boolean {
  if (!Array.isArray(descriptor.rules) || descriptor.rules.length === 0) return false;
  return descriptor.rules.every(
    (rule, index) => rule.when !== undefined || index === descriptor.rules.length - 1,
  );
}

function formatDescriptorFrom(value: unknown): FormatDescriptor | null {
  if (!isRecord(value) || !Array.isArray(value.rules)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const label = typeof value.label === 'string' ? value.label : null;
  if (!id || !label) return null;
  const descriptor: FormatDescriptor = {
    id,
    label,
    ...(value.scope === "block" || value.scope === "selection" ? { scope: value.scope } : {}),
    rules: value.rules as FormatRule[],
    ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
    ...(typeof value.group === 'string' ? { group: value.group } : {}),
    ...(typeof value.swatch === 'string' ? { swatch: value.swatch } : {}),
    ...(isRecord(value.active) ? { active: value.active as unknown as FormatPredicate } : {}),
  };
  return isFormatDescriptorValid(descriptor) ? descriptor : null;
}

// Formats are enum-dissolved exactly like materials (readMaterialDescriptors): live
// user/package-published descriptor ROWS merge with the built-in seeds — a package adds
// a "Code" or "Quote" format as DATA, zero renderer/primitive code change. A live row
// whose id matches a built-in OVERRIDES it (live data wins); built-ins fill the rest.
export function readFormatDescriptors(raw: unknown): FormatDescriptor[] {
  const values = isRecord(raw) && Array.isArray(raw.formats)
    ? flattenProjectedRows(raw.formats)
    : flattenProjectedRows(raw);
  const read = values
    .map(formatDescriptorFrom)
    .filter((value): value is FormatDescriptor => value !== null);
  const overridden = new Set(read.map((d) => d.id));
  return [...read, ...FORMAT_DESCRIPTORS.filter((d) => !overridden.has(d.id))];
}

// ── Input-shorthand → block-transform primitive (the generic autoformat engine) ──
//
// THE GENERATIVE PRIMITIVE (L069/L124/enum-dissolution), converged with two independent
// Codex GPT-5.5 xhigh passes. TWO parts, DECOUPLED (the earlier draft entangled them — a
// matcher that reached into an effect field, plus a closed `{set|prependText|replaceNode}`
// effect union that would need a new handler branch per new effect = instance-solving):
//
//   1. RECOGNITION (pure): matchAutoformat(text, trigger, rules) → { rule, captured:{text} }.
//      It ONLY extracts the captured text (prefix stripped). It NEVER looks at the effect.
//   2. EFFECT (open DATA): rule.effect is a list of ScenePatch TEMPLATES whose values may be
//      `{$kind:'binding', select:{from,path}}` / `{$kind:'template', parts:[…]}` — resolved by
//      the SAME resolveBindingTemplate the action-affordance system uses (ONE substitution
//      language platform-wide, not a second engine). The applier resolves the templates and
//      commits them, BLIND to what they do. So a heading, a bullet, a divider, a toggle, a
//      table, or "run an AI action on the text" are ALL just DATA rows — adding one is ZERO
//      engine/handler code. A user can drop `{prefix:'-~-', trigger:'enter', effect:[…]}`.
//
// ctx bag the effect templates read (documented, NOT enumerated by the resolver):
//   captured.text          → block text after the prefix is stripped
//   block.id               → the transforming block's node id
//   parent.id/.index/.next → for a replace: where to drop the new node + a trailing block
//   fresh.id/.id2          → fresh node ids minted per apply
//
// The SAME rules + the pure foldAutoformatToNodes drive AI-produced markdown (an AI `# Foo`
// becomes a real H1 block, `---` a divider) — one code path, no second parser.
export type ScenePatchTemplate = Record<string, unknown>;
export type AutoformatRule = {
  id: string;
  conversion_label?: string;
  // Literal typed at the very start of a block. `trigger:'space'` fires the moment the user
  // types this prefix followed by a SPACE; `trigger:'enter'` fires when the whole block text
  // IS the prefix and Enter is pressed (divider-style).
  prefix: string;
  trigger: 'space' | 'enter';
  // Open scene-patch template list, resolved via resolveBindingTemplate against the ctx bag.
  effect: ScenePatchTemplate[];
  material_template?: { id: string; content_role?: string; state?: string };
  // Keep the matched prefix in the captured text (rare). Default false = strip it.
  keepPrefix?: boolean;
  // NUMERIC gesture (L063): instead of ONE fixed prefix, match ANY leading ordinal marker
  // (`1. `, `42) `, …). The matcher owns the (fixed, ReDoS-safe) recognition — DATA only flips
  // this flag, so a single rule yields infinite numbered items with zero per-number rows. The
  // literal marker the user typed is exposed as `captured.match` so the effect can re-emit it.
  numeric?: boolean;
};

// There is NO rule table in this source. Every input-shortcut (# -> H1, ~> -> spark,
// -~- -> wave divider, and any user/package-authored rule) lives as DATA — a
// `kind:"input-shortcut"` / `input-shortcut-set` published-record read BY KIND across
// the whole feed (see readInputShortcuts below). The built-in set ships as DATA in this
// package's things-to-store-and-run.json at address documents.input-shortcuts.
// Physics-vs-Society / L030 / L090: the source is a blind matcher + decoder, the rules are
// configuration. Adding/overriding a rule = one DATA row, zero source edit.

// RECOGNITION ONLY — decoupled from the effect (Codex: the matcher must never reach into an
// effect field). LONGEST prefix wins so `###` beats `#` and `[x]` beats `[`. Returns the rule
// + the captured text (prefix stripped unless keepPrefix). Pure — no engine, no effect read.
// `captured.match` = the literal marker the matcher consumed (the ordinal for a numeric rule,
// e.g. "1.", "42)"); absent for a plain fixed-prefix rule (nothing to re-emit).
export type AutoformatMatch = { rule: AutoformatRule; captured: { text: string; match?: string } };
// The (fixed, bounded — no DATA-supplied regex, so ReDoS-safe) ordinal recognizer for numeric
// rules: any run of digits followed by `.` or `)` at the very block start, then a space.
const NUMERIC_ORDINAL = /^(\d+[.)]) /;
export function matchAutoformat(
  blockText: string,
  trigger: 'space' | 'enter',
  rules: AutoformatRule[],
): AutoformatMatch | null {
  // Exact fixed-prefix rules are tried FIRST (longest wins), so a specific prefix always beats
  // the catch-all numeric gesture; numeric rules (prefix-less) sort last and only fire on a real
  // ordinal. `space`-triggered numeric rules only — an `enter` divider has no ordinal to capture.
  const ordered = rules
    .filter((rule) => rule.trigger === trigger && (rule.prefix.length > 0 || rule.numeric))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of ordered) {
    if (trigger === 'space') {
      if (rule.numeric) {
        const found = NUMERIC_ORDINAL.exec(blockText);
        if (found) {
          return {
            rule,
            captured: {
              text: rule.keepPrefix ? blockText : blockText.slice(found[0].length),
              match: found[1],
            },
          };
        }
        continue;
      }
      const needle = `${rule.prefix} `;
      if (blockText.startsWith(needle)) {
        return { rule, captured: { text: rule.keepPrefix ? blockText : blockText.slice(needle.length) } };
      }
    } else {
      const bare = blockText.trimEnd();
      if (bare === rule.prefix) {
        return { rule, captured: { text: rule.keepPrefix ? blockText : '' } };
      }
    }
  }
  return null;
}

// The ctx bag an effect template resolves against (passed to resolveBindingTemplate as the
// `ctx`; the resolver reads ctx[from] generically). The surface fills the ids per apply.
export type AutoformatContext = {
  captured: { text: string; match?: string };
  block: { id: string };
  parent: { id: string; index: number; next: number };
  fresh: { id: string; id2: string };
};

// Live-overridable rule set (same merge shape as readFormatDescriptors): a package may ship
// its own autoformat rows; unknown ids extend, known ids override. Falls back to the
// built-ins. Generic — never names a prefix/effect, just validates {id,prefix,trigger,effect}.
// THE input-shortcut registry reader — the ONLY source of rules at runtime (there is NO
// code-constant fallback; the built-ins live as DATA in the log, L030/L101). It reads BY KIND
// across the ENTIRE published-records feed (same pattern as readPlaceableSurfaceMaterials): a
// row is an input-shortcut if its payload is `{kind:"input-shortcut", …}` (an individual rule
// any package may ship in its OWN things-to-store-and-run.json) OR `{kind:"input-shortcut-set",
// rules:[…]}` (the compact seed), OR a bare-array record of rules. So a quintillion packages
// each add rules with ZERO documents code and no redeploy (L090 self-describing).
// The DATA shape is `{id, match:{prefix,terminator,…}, effect_template|token_template|dispatch}`;
// this maps it to the internal runtime rule (matchAutoformat/foldAutoformatToNodes operate on it).
// Later ids override earlier ids (priority), so a package can shadow a built-in by id.
export function readInputShortcuts(raw: unknown): AutoformatRule[] {
  const byId = new Map<string, AutoformatRule>();
  const add = (value: unknown) => {
    const rule = inputShortcutToRule(value);
    if (rule) byId.set(rule.id, rule);
  };
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'input-shortcut') add(payload);
    else if (isRecord(payload) && payload.kind === 'input-shortcut-set' && Array.isArray(payload.rules)) {
      for (const r of payload.rules) add(r);
    } else if (Array.isArray(payload)) {
      for (const r of payload) add(r);
    }
  }
  return [...byId.values()];
}

// Map a self-describing input-shortcut DATA row to the internal runtime rule. Accepts both the
// nested `match:{prefix,terminator}` shape and the flat `{prefix,trigger}` legacy shape, and both
// `effect_template` and `effect`. Returns null (skipped) if it lacks id/prefix/effect — a
// forward-compatible token/dispatch-only shortcut simply carries no `effect` and is handled by the
// renderer/dispatch pipeline, not this transform reader.
function inputShortcutToRule(value: unknown): AutoformatRule | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const match = isRecord(value.match) ? value.match : null;
  const prefix = match && typeof match.prefix === 'string' ? match.prefix
    : (typeof value.prefix === 'string' ? value.prefix : null);
  const terminator = match && typeof match.terminator === 'string' ? match.terminator
    : (typeof value.trigger === 'string' ? value.trigger : 'space');
  const trigger: 'space' | 'enter' = terminator === 'enter' ? 'enter' : 'space';
  const effect = Array.isArray(value.effect_template) ? (value.effect_template as ScenePatchTemplate[])
    : (Array.isArray(value.effect) ? (value.effect as ScenePatchTemplate[]) : null);
  const materialTemplate = isRecord(value.material_template) && typeof value.material_template.id === "string"
    ? { id: value.material_template.id, ...(typeof value.material_template.content_role === "string" ? { content_role: value.material_template.content_role } : {}), ...(typeof value.material_template.state === "string" ? { state: value.material_template.state } : {}) }
    : undefined;
  // A numeric rule matches ANY ordinal (no fixed prefix), so it is exempt from the prefix
  // requirement; the matcher supplies the recognizer + `captured.match`.
  const numeric = (match && match.numeric === true) || value.numeric === true;
  if (!id || (!effect && !materialTemplate) || (!prefix && !numeric && typeof value.conversion_label !== 'string')) return null;
  const rule: AutoformatRule = { id, prefix: prefix ?? "", trigger, effect: effect ?? [], ...(materialTemplate ? { material_template: materialTemplate } : {}) };
  if (typeof value.conversion_label === 'string' && value.conversion_label.trim()) rule.conversion_label = value.conversion_label;
  if (value.keepPrefix === true) rule.keepPrefix = true;
  if (numeric) rule.numeric = true;
  return rule;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE UNIFIED input-shortcut model (W4 — the L124 command-composer). The SAME
// DATA registry that carries autoformat effect rows ALSO carries menu / picker /
// composer / dispatch rows. `readInputShortcuts` above is the effect-only VIEW
// (autoformat + AI-markdown); `readInputShortcutsFull` below keeps EVERY row so
// the surface can also open menus/pickers/composers and dispatch to any envelope
// target. The surface stays blind: it never names a prefix, renderer, target, or
// package — it reads the live registry and routes by SHAPE (L090). Adding a
// slash/mention/ask-AI/workflow shortcut is ONE DATA row, zero source edit.
// ─────────────────────────────────────────────────────────────────────────────
export type InputShortcutMatchDef = {
  prefix?: string;
  // 'space'/'enter' = a TERMINATED gesture (block text ends the trigger, apply now).
  // absent = a live-open gesture matched while typing (menu/picker/composer).
  terminator?: 'space' | 'enter';
  gesture?: string;      // informational: 'prefix' | 'key' (open — never branched on)
  at?: string;           // informational: 'block-start' | 'empty-block'
  query_from?: string;   // informational: 'after_prefix'
  key?: string;          // for key gestures (e.g. ' ' on an empty block → composer)
  // NUMERIC gesture: match ANY leading ordinal marker instead of one fixed prefix. Carried through
  // so a continued item can re-emit the NEXT ordinal rather than repeating the same one.
  numeric?: boolean;
};
/** Closed DATA answers for Enter; unrecognized values are ignored by the decoder. */
export type WhatEnterDoesOutcome = 'make_another_one_like_this' | 'leave_this_kind';
export type WhatEnterDoesData = {
  in_a_filled_one?: WhatEnterDoesOutcome;
  in_an_empty_one?: WhatEnterDoesOutcome;
  /** Shortcut DATA selects the kind of fresh item to continue with. */
  continue_as?: string;
};
/** How authored text from a rule is interpreted while someone edits one of its blocks. */
export type TextInputPolicy = {
  /** Keep authored characters literal instead of applying shortcuts, inline marks or reference tokens. */
  mode?: 'literal';
  /** Enter's generic edit operation for this block. */
  enter?: 'line_break';
  /** Copy leading spaces/tabs from the current line after an inserted line break. */
  indentation?: 'copy';
  /** Whitespace inserted by Tab and removed from line starts by Shift+Tab. */
  indent_unit?: string;
};
/** Resolve an authored text-editing policy by the lineage a rule placed on the block. */
export function textInputPolicyFor(shortcuts: readonly InputShortcut[], shortcutId: unknown): TextInputPolicy | null {
  if (typeof shortcutId !== 'string') return null;
  return shortcuts.find(rule => rule.id === shortcutId)?.text_input ?? null;
}

/** The text inserted by a DATA-requested literal line break, including copied leading indentation. */
export function literalLineBreak(text: string, offset: number, policy: TextInputPolicy): string {
  if (policy.enter !== 'line_break') return '';
  if (policy.indentation !== 'copy') return '\n';
  const at = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? offset : text.length));
  const lineStart = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  const leading = /^[\t ]*/.exec(text.slice(lineStart, at))?.[0] ?? '';
  return `\n${leading}`;
}

/** Edit indentation in text coordinates; block structure and words stay intact. */
export function literalIndentEdit(text: string, start: number, end: number, unit: string, outdent = false): { text: string; start: number; end: number } {
  if (!/^[\t ]{1,16}$/.test(unit)) return { text, start, end };
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  if (!outdent && start === end) {
    return { text: text.slice(0, start) + unit + text.slice(end), start: start + unit.length, end: start + unit.length };
  }
  const edits: { at: number; remove: number; insert: string }[] = [];
  let at = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  do {
    const remove = !outdent ? 0 : text.startsWith(unit, at) ? unit.length : text[at] === '\t' ? 1
      : Math.min(unit.length, /^ */.exec(text.slice(at))?.[0].length ?? 0);
    edits.push({ at, remove, insert: outdent ? '' : unit });
    const next = text.indexOf('\n', at);
    if (next < 0 || next + 1 >= end) break;
    at = next + 1;
  } while (at < end);
  const map = (offset: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (offset < edit.at) break;
      if (offset < edit.at + edit.remove) return edit.at + delta + edit.insert.length;
      delta += edit.insert.length - edit.remove;
    }
    return offset + delta;
  };
  const nextStart = map(start), nextEnd = map(end);
  for (const edit of edits.reverse()) text = text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove);
  return { text, start: nextStart, end: nextEnd };
}
// A self-describing input-shortcut row. Exactly ONE of effect_template / token_template
// / dispatch is the result (read by shape, never a kind field). presentation.renderer is
// an OPEN capability key the surface paints (none | menu | picker | composer).
export type InputShortcut = {
  id: string;
  match: InputShortcutMatchDef;
  // `config` is the shortcut's OPTIONAL disclosure panel, pure DATA: which option records to
  // list (by kind), how to read the current choice, and what to dispatch on select. The surface
  // renders it blind — every name (kinds, targets, definition ids) lives in the row.
  presentation?: { renderer?: string; option_sources?: unknown[]; ask?: unknown; hint?: string; config?: Record<string, unknown>; working?: string };
  effect_template?: ScenePatchTemplate[];
  material_template?: { id: string; content_role?: string; state?: string };
  token_template?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  priority?: number;
  keepPrefix?: boolean;
  // What Enter does inside a block THIS rule produced. Pure DATA: a row opts into continuation by
  // declaring it, and the key handler stays blind to what kind of thing the row makes. A row that
  // says nothing keeps the old behaviour (Enter makes a plain block).
  what_enter_does?: WhatEnterDoesData;
  /** Optional authored text-editing behavior; the editor executes it without knowing the rule's kind. */
  text_input?: TextInputPolicy;
  /** Whether the blocks this rule makes may be indented with the editor's generic nesting command. */
  indentable?: boolean;
  // How a block this rule made is written as markdown: a template over { block: { text, words } }.
  markdown?: unknown;
};

// The empty-block placeholder is a PROJECTION of the live input-shortcut registry, NOT a
// static string: every shortcut that carries a `presentation.hint` advertises itself on the
// focused empty block, block-state gestures (match.at === 'empty-block', e.g. space→AI) listed
// before inline char-triggers (/, @). Hint PRESENCE is the DATA opt-in — a package that adds a
// `input-shortcut` row with a hint sees it in the placeholder with ZERO code change; deleting a
// row drops its hint (L090 / L124 / enum-dissolution). Returns null when nothing advertises, so
// the caller falls back to its own capable default (never a bare box).
export function composeEmptyBlockPlaceholder(shortcuts: InputShortcut[]): string | null {
  const advertised = shortcuts.filter(
    (s) => typeof s.presentation?.hint === 'string' && s.presentation.hint.trim() !== '',
  );
  if (advertised.length === 0) return null;
  const rank = (s: InputShortcut) => (s.match?.at === 'empty-block' ? 0 : 1);
  // Stable sort (Array.prototype.sort is stable) keeps registry order within each rank.
  const ordered = advertised.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i);
  return `Write, ${ordered.map(({ s }) => s.presentation!.hint!.trim()).join(', ')}`;
}

// The composer's own chrome copy (dialog/submit label + input placeholder) is a PROJECTION
// of the registry rows, never JSX literals (F3 gauntlet correction — the row's
// `presentation.ask.fields[0]` already carried label/placeholder while the JSX duplicated
// them): the label is the ask field's label; the placeholder composes the ask field's own
// placeholder with every OTHER advertised row's hint that can fire inside the composer
// (match.at !== 'empty-block' — block-state gestures need a block, DATA-keyed, no name
// checks). Same registry projection as composeEmptyBlockPlaceholder: a package rewording
// its row rewords the composer; a new picker row with a hint advertises itself; deleting a
// row drops its hint (L090). Fallbacks keep the surface capable when a row ships no ask
// (L083 — the DEFAULT_BLOCK_PLACEHOLDER precedent).
export function composerAskCopy(
  composer: InputShortcut | null,
  all: InputShortcut[],
): { label: string; placeholder: string; working: string } {
  const askRaw = composer?.presentation?.ask;
  const fields = isRecord(askRaw) && Array.isArray(askRaw.fields) ? askRaw.fields : [];
  const first = fields.find(isRecord);
  const label = first && typeof first.label === 'string' && first.label.trim() !== ''
    ? first.label.trim() : 'Ask AI';
  const own = first && typeof first.placeholder === 'string' && first.placeholder.trim() !== ''
    ? first.placeholder.trim() : null;
  const hints = all
    .filter((s) => s !== composer
      && typeof s.presentation?.hint === 'string' && s.presentation.hint.trim() !== ''
      && s.match?.at !== 'empty-block')
    .map((s) => s.presentation!.hint!.trim());
  const parts = [own, ...hints].filter((p): p is string => p != null);
  // What the composer says while the ask runs: the row's own `presentation.working`, else plainly "Writing".
  const working = typeof composer?.presentation?.working === 'string' && composer.presentation.working.trim() !== ''
    ? composer.presentation.working.trim() : 'Writing';
  return { label, placeholder: parts.length ? parts.join('  ') : label, working };
}

function inputShortcutFull(value: unknown): InputShortcut | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  if (!id) return null;
  // Accept the nested `match:{…}` shape AND the flat legacy `{prefix,trigger}` shape.
  const matchRaw = isRecord(value.match) ? value.match : {};
  const prefix = typeof matchRaw.prefix === 'string' ? matchRaw.prefix
    : (typeof value.prefix === 'string' ? value.prefix : undefined);
  const terminatorRaw = typeof matchRaw.terminator === 'string' ? matchRaw.terminator
    : (typeof value.trigger === 'string' ? value.trigger : undefined);
  const terminator = terminatorRaw === 'enter' ? 'enter' : terminatorRaw === 'space' ? 'space' : undefined;
  const match: InputShortcutMatchDef = {
    prefix,
    terminator,
    gesture: typeof matchRaw.gesture === 'string' ? matchRaw.gesture : undefined,
    at: typeof matchRaw.at === 'string' ? matchRaw.at : undefined,
    query_from: typeof matchRaw.query_from === 'string' ? matchRaw.query_from : undefined,
    key: typeof matchRaw.key === 'string' ? matchRaw.key : undefined,
    numeric: matchRaw.numeric === true ? true : undefined,
  };
  const shortcut: InputShortcut = { id, match };
  if (isRecord(value.presentation)) {
    shortcut.presentation = {
      renderer: typeof value.presentation.renderer === 'string' ? value.presentation.renderer : undefined,
      option_sources: Array.isArray(value.presentation.option_sources) ? value.presentation.option_sources : undefined,
      ask: value.presentation.ask,
      hint: typeof value.presentation.hint === 'string' ? value.presentation.hint : undefined,
      config: isRecord(value.presentation.config) ? (value.presentation.config as Record<string, unknown>) : undefined,
      working: typeof value.presentation.working === 'string' ? value.presentation.working : undefined,
    };
  }
  if (isRecord(value.what_enter_does)) {
    const declared = value.what_enter_does;
    const outcome = (candidate: unknown): WhatEnterDoesOutcome | undefined =>
      candidate === 'make_another_one_like_this' || candidate === 'leave_this_kind' ? candidate : undefined;
    const filled = outcome(declared.in_a_filled_one);
    const empty = outcome(declared.in_an_empty_one);
    const continueAs = typeof declared.continue_as === 'string' && declared.continue_as.trim() ? declared.continue_as.trim() : undefined;
    if (filled || empty || continueAs) shortcut.what_enter_does = {
      ...(filled ? { in_a_filled_one: filled } : {}),
      ...(empty ? { in_an_empty_one: empty } : {}),
      ...(continueAs ? { continue_as: continueAs } : {}),
    };
  }
  if (isRecord(value.text_input)) {
    const policy: TextInputPolicy = {
      ...(value.text_input.mode === 'literal' ? { mode: 'literal' as const } : {}),
      ...(value.text_input.enter === 'line_break' ? { enter: 'line_break' as const } : {}),
      ...(value.text_input.indentation === 'copy' ? { indentation: 'copy' as const } : {}),
      ...(typeof value.text_input.indent_unit === 'string' && /^[\t ]{1,16}$/.test(value.text_input.indent_unit)
        ? { indent_unit: value.text_input.indent_unit } : {}),
    };
    if (Object.keys(policy).length) shortcut.text_input = policy;
  }
  if (Array.isArray(value.effect_template)) shortcut.effect_template = value.effect_template as ScenePatchTemplate[];
  else if (Array.isArray(value.effect)) shortcut.effect_template = value.effect as ScenePatchTemplate[];
  if (isRecord(value.material_template) && typeof value.material_template.id === "string") {
    shortcut.material_template = { id: value.material_template.id, ...(typeof value.material_template.content_role === "string" ? { content_role: value.material_template.content_role } : {}), ...(typeof value.material_template.state === "string" ? { state: value.material_template.state } : {}) };
  }
  if (isRecord(value.token_template)) shortcut.token_template = value.token_template as Record<string, unknown>;
  if (isRecord(value.dispatch)) shortcut.dispatch = value.dispatch as Record<string, unknown>;
  if (value.markdown !== undefined) shortcut.markdown = value.markdown;
  if (typeof value.priority === 'number') shortcut.priority = value.priority;
  if (value.keepPrefix === true) shortcut.keepPrefix = true;
  if (value.indentable === true) shortcut.indentable = true;
  return shortcut;
}

// ── The INLINE-MARK table reader — the DATA vocabulary behind inline text decoration ──────────────
// A mark row `{id, open_marker, close_marker, render_tag, legacy_tags?}` says "this marker pair
// renders as this element" (`**…**` → <strong>, `~~…~~` → <s>, ANY pair a package invents). The
// parser/renderer/serializer (inline-tokens.ts / inline-chip-dom.ts) compile whatever rows this
// returns — they never name a marker or a tag (L090 / enum-dissolution; the 2026-07-11 gauntlet
// audit caught `**`/`*` hardcoded as a closed set). Same by-kind read as the input-shortcut
// registry: `{kind:"inline-mark"}` rows and `{kind:"inline-mark-set", marks:[…]}` sets, from ANY
// package's records, later ids overriding earlier. No code fallback — no rows ⇒ no marks (the
// plain-text path), exactly as an empty shortcut registry means no shortcuts.
export function readInlineMarks(raw: unknown): InlineMark[] {
  const byId = new Map<string, InlineMark>();
  const add = (value: unknown) => {
    if (!isRecord(value)) return;
    const id = typeof value.id === 'string' ? value.id : null;
    const open = typeof value.open_marker === 'string' ? value.open_marker : null;
    const close = typeof value.close_marker === 'string' ? value.close_marker : null;
    const tag = typeof value.render_tag === 'string' ? value.render_tag : null;
    if (!id || !open || !close || !tag) return;
    const mark: { id: string; open_marker: string; close_marker: string; render_tag: string; legacy_tags?: readonly string[]; style?: Readonly<Record<string, string>> } =
      { id, open_marker: open, close_marker: close, render_tag: tag };
    if (Array.isArray(value.legacy_tags)) {
      mark.legacy_tags = value.legacy_tags.filter((t): t is string => typeof t === 'string');
    }
    if (isRecord(value.style)) {
      const style: Record<string, string> = {};
      for (const [property, raw] of Object.entries(value.style)) {
        if (typeof raw === 'string' && raw.trim() && raw.length <= 256 && !/[{};\u0000-\u001f]/.test(raw) && !/url\s*\(|expression\s*\(/i.test(raw)) style[property] = raw;
      }
      if (Object.keys(style).length) mark.style = style;
    }
    byId.set(id, mark);
  };
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'inline-mark') add(payload);
    else if (isRecord(payload) && payload.kind === 'inline-mark-set' && Array.isArray(payload.marks)) {
      for (const m of payload.marks) add(m);
    }
  }
  return [...byId.values()];
}

// ── The EMPTY-STATE seed reader — what a page holds when it holds nothing, as DATA ──────────────
// The owner (2026-07-11): select-all + Backspace deleted every block and left NO way to type — and he
// called it himself: the generic delete made zero-blocks a VALID state, so the empty state is
// Society DATA, not a hardcoded "always one blank block." A `kind:"composition-empty-state"`
// record carries `nodes:[…]` — 1 blank block, 10 prefilled blocks, a whole template — and the
// surface re-materializes them (fresh ids) whenever the framed page hits zero children. No record
// ⇒ null ⇒ the surface applies its capable single-blank default (L083), so the box is never
// dead; a package/user overrides by shipping/live-writing ONE record. Same by-kind fold as every
// other registry here (L090).
export function readEmptyStateSeed(raw: unknown): Record<string, unknown>[] | null {
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'composition-empty-state' && Array.isArray(payload.nodes)) {
      const nodes = payload.nodes.filter(isRecord);
      if (nodes.length > 0) return nodes as Record<string, unknown>[];
    }
  }
  return null;
}

/** Materialize seed node templates into insertable scene nodes: every node (and descendant)
 *  gets a FRESH id (a seed is a TEMPLATE, never a fixed identity — re-seeding twice must never
 *  collide), `kind` defaults to Text, `visible` to true, props deep-cloned so repeated seeds
 *  never share mutable style objects. Pure; unit-testable. */
export function materializeEmptyStateSeed(
  templates: readonly Record<string, unknown>[],
  makeId: () => string,
): SceneNode[] {
  const build = (t: Record<string, unknown>): SceneNode => ({
    id: makeId(),
    kind: typeof t.kind === 'string' ? t.kind : 'Text',
    props: isRecord(t.props) ? (JSON.parse(JSON.stringify(t.props)) as SceneNode['props']) : { text: '' },
    visible: t.visible === false ? false : true,
    children: Array.isArray(t.children) ? t.children.filter(isRecord).map(build) : [],
  });
  return templates.map(build);
}

// The FULL registry reader — same by-kind flatten as readInputShortcuts, but keeps every
// row (menu/picker/composer/dispatch/token, not only effect). Later ids override earlier.
export function readInputShortcutsFull(raw: unknown): InputShortcut[] {
  const byId = new Map<string, InputShortcut>();
  const add = (value: unknown) => {
    const s = inputShortcutFull(value);
    if (s) byId.set(s.id, s);
  };
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'input-shortcut') add(payload);
    else if (isRecord(payload) && payload.kind === 'input-shortcut-set' && Array.isArray(payload.rules)) {
      for (const r of payload.rules) add(r);
    } else if (Array.isArray(payload)) {
      for (const r of payload) add(r);
    }
  }
  return [...byId.values()];
}

// The result of matching a live keystroke/input against the DATA registry. `mode` mirrors the
// gesture timing: 'space'/'enter' = a terminated apply-now gesture; 'inline' = a live-open gesture
// (menu/picker/composer) matched WHILE typing. `renderer` is the resolved capability key; the
// surface routes by which result field the shortcut carries (effect_template / dispatch /
// token_template) — SHAPE, not a kind field (L090). `query` is the text after the prefix (for
// inline menus/pickers); `captured` is the text kept for a terminated transform/dispatch.
export type InputShortcutMatch = {
  shortcut: InputShortcut;
  captured: { text: string };
  query: string;
  renderer: string;
  // For inline caret-token scope: the flat [start,end) span of the matched prefix+query token, so the
  // caller can splice a replacement (a chip / the transformed text) at EXACTLY the caret, not the block
  // trailing token. Absent for block-start scope (the whole block IS the token).
  range?: { start: number; end: number };
};

// ── Inline scope predicates: WHERE the prefix may sit, chosen by the row's `match.at` DATA ────────────
// Self-describing data (the `at` key) + a generic handler that looks the scope up (L090 / enum-dissolution):
// the matcher NEVER hardcodes "prefix must be at block start". A scope is a pure predicate over
// (blockText, prefix, caretOffset) → the matched query + optional caret span. Adding a scope (e.g. a
// future 'line-start' for multi-line blocks) is ONE entry here, never a branch in the hot matcher.
type InlineScopeHit = { query: string; range?: { start: number; end: number } };
const INLINE_SCOPES: Record<string, (blockText: string, prefix: string, caretOffset: number) => InlineScopeHit | null> = {
  // The prefix opens the shortcut only when it starts the block (markdown-style: '#', '>' at line start).
  'block-start': (blockText, prefix) =>
    blockText.startsWith(prefix) ? { query: blockText.slice(prefix.length) } : null,
  // The whitespace-delimited token ENDING at the caret starts with the prefix (Notion-style: @ / slash
  // fire anywhere inline). Reuses the SAME activeTokenAt the composer proved. Returns the token's flat
  // span so the caller splices the replacement exactly there. caretOffset defaults (in the matcher) to
  // end-of-text, so an un-threaded caller degrades to "the trailing token" — never worse than before.
  'caret-token': (blockText, prefix, caretOffset) => {
    const token = activeTokenAt(blockText, caretOffset);
    if (!token.startsWith(prefix)) return null;
    const at = caretOffset >= 0 && caretOffset <= blockText.length ? caretOffset : blockText.length;
    return { query: token.slice(prefix.length), range: { start: at - token.length, end: at } };
  },
};

// The ONE blind matcher over the DATA registry — subsumes readSlashQuery ('inline' mode) and the
// autoformat space/enter recognition (for dispatch/open rows; the effect path keeps using
// matchAutoformat over the AutoformatRule view). Longest-prefix wins, then higher `priority`.
export function matchInputShortcut(
  blockText: string,
  mode: 'space' | 'enter' | 'inline',
  shortcuts: InputShortcut[],
  caretOffset?: number,
): InputShortcutMatch | null {
  const rendererOf = (s: InputShortcut) => s.presentation?.renderer ?? 'none';
  const candidates = shortcuts.filter((s) => {
    if (typeof s.match.prefix !== 'string' || s.match.prefix.length === 0) return false;
    const term = s.match.terminator;
    const renderer = rendererOf(s);
    if (mode === 'inline') {
      // Live-open families: a menu/picker/composer opened while typing after the prefix.
      return renderer === 'menu' || renderer === 'picker' || renderer === 'composer';
    }
    // Terminated families: the gesture completes on space/enter. Default terminator = space.
    const effectiveTerm = term ?? 'space';
    return effectiveTerm === mode && (renderer === 'none');
  });
  const ordered = candidates.sort((a, b) => {
    const byLen = (b.match.prefix?.length ?? 0) - (a.match.prefix?.length ?? 0);
    if (byLen !== 0) return byLen;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  for (const s of ordered) {
    const prefix = s.match.prefix as string;
    if (mode === 'space') {
      const needle = `${prefix} `;
      if (blockText.startsWith(needle)) {
        const text = s.keepPrefix ? blockText : blockText.slice(needle.length);
        return { shortcut: s, captured: { text }, query: '', renderer: rendererOf(s) };
      }
    } else if (mode === 'enter') {
      if (blockText.trimEnd() === prefix) {
        return { shortcut: s, captured: { text: s.keepPrefix ? blockText : '' }, query: '', renderer: rendererOf(s) };
      }
    } else {
      // inline: the scope where the prefix may sit is DATA (`match.at`) resolved through INLINE_SCOPES —
      // NOT a hardcoded "block start". 'block-start' (default) keeps the old behavior; 'caret-token' fires
      // mid-block. caretOffset defaults to end-of-text so an un-threaded caller degrades to trailing-token.
      const scope = INLINE_SCOPES[s.match.at ?? 'block-start'] ?? INLINE_SCOPES['block-start'];
      const hit = scope(blockText, prefix, typeof caretOffset === 'number' ? caretOffset : blockText.length);
      if (hit) {
        return { shortcut: s, captured: { text: hit.query }, query: hit.query, renderer: rendererOf(s), ...(hit.range ? { range: hit.range } : {}) };
      }
    }
  }
  return null;
}

// Split AI-produced text into lines for the markdown pass. Blank lines are dropped (blocks
// already carry a flow gap). Each line is matched against the SAME rules by the surface, so
// there is no second markdown parser — one recognition primitive drives typing AND AI.
export function splitMarkdownLines(md: string): string[] {
  return md.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim() !== '');
}

// Fold "effect patches resolved over a FRESH base block" into the node(s) to INSERT — so the
// AI-markdown path reuses the EXACT same rules + effect templates as live typing (one
// primitive, zero duplication). Apply the resolved patches in order to a working node list
// seeded with the base block: UPDATE_PROPS(base) merges props/style, REMOVE_SUBTREE(base)
// drops it, INSERT_NODE adds a node. Blind to WHICH effect — any DATA effect folds correctly.
export function foldAutoformatToNodes(resolvedPatches: ScenePatch[], baseNode: SceneNode): SceneNode[] {
  let nodes: SceneNode[] = [{ ...baseNode, props: propsBeforeShortcut(baseNode.props) }];
  for (const patch of resolvedPatches) {
    if (patch.type === 'UPDATE_PROPS') {
      nodes = nodes.map((node) => (node.id === patch.node_id ? mergeNodeProps(node, patch.changes) : node));
    } else if (patch.type === 'REMOVE_SUBTREE') {
      nodes = nodes.filter((node) => node.id !== patch.node_id);
    } else if (patch.type === 'INSERT_NODE') {
      nodes.push(patch.node);
    }
  }
  return nodes;
}

/** A kind change replaces heading semantics while retaining imported lineage and other custom data. */
export function propsBeforeShortcut(props: Record<string, unknown> | undefined, previousEffect: readonly ScenePatch[] = []): Record<string, unknown> {
  const custom = isRecord(props?.custom) ? props.custom : null;
  const next: Record<string, unknown> = custom && Object.hasOwn(custom, 'heading_level')
    ? { ...props, custom: { ...custom, heading_level: null } }
    : { ...props };
  // Only the prior shortcut's authored style keys belong to the block kind.
  // Explicit nulls survive the engine's merging UPDATE_PROPS; omitting a key
  // would leave a heading's size/weight behind when changing it to a quote/list.
  const style = isRecord(props?.style) ? { ...props.style } : {};
  for (const patch of previousEffect) {
    if (patch.type !== 'UPDATE_PROPS') continue;
    const changes = patch.changes.props;
    if (isRecord(changes?.style)) for (const key of Object.keys(changes.style)) style[key] = null;
    if (changes && Object.hasOwn(changes, 'look')) next.look = null;
  }
  if (Object.keys(style).length) next.style = style;
  return next;
}

/** Identify a material's editable content without treating its synthetic chrome
 * as authored words. Detaching a material preserves its other content trees and
 * opens only visibility that depended on the removed disclosure owner. */
export function blockConversionSource(root: SceneNode, nodeId: string): { node: SceneNode; unit: SceneNode; remainder: SceneNode[] } | null {
  const path: SceneNode[] = [];
  const locate = (node: SceneNode): boolean => {
    path.push(node);
    if (node.id === nodeId) return true;
    for (const child of node.children ?? []) if (locate(child)) return true;
    path.pop(); return false;
  };
  if (!locate(root)) return null;
  const clicked = path.at(-1)!;
  const unit = [...path].reverse().find(node => typeof node.props?.shortcut_material_id === 'string');
  if (!unit || (clicked.kind === 'Text' && clicked.props?.content_role !== 'primary')) {
    return clicked.kind === 'Text' && !clicked.children?.length ? { node: clicked, unit: clicked, remainder: [] } : null;
  }
  const primary = (node: SceneNode): SceneNode | null => {
    if (node.kind === 'Text' && node.synthetic !== true && node.props?.content_role === 'primary') return node;
    for (const child of node.children ?? []) { const found = primary(child); if (found) return found; }
    return null;
  };
  const content = primary(unit);
  if (!content) return null;
  const preserve = (node: SceneNode): SceneNode | null => {
    if (node.id === content.id || (node.synthetic === true && !node.children?.length)) return null;
    const children = (node.children ?? []).map(preserve).filter((child): child is SceneNode => child !== null);
    if (node.children?.length && !children.length) return null;
    if (node.kind === 'Text' && !String(node.props?.text ?? '').length && node.props?.content_role) return null;
    // An empty slot of the material (a To-do's body before anything is nested in it) carries nothing authored, so it
    // never takes the place of the new material's own declared slot.
    if (node.kind === 'Container' && node.props?.content_role && !node.children?.length) return null;
    const visible = node.visible;
    const detached = isRecord(visible) && visible.$kind === 'binding' && isRecord(visible.select)
      && visible.select.from === 'fsm' && (visible.select.path === unit.id || visible.select.path === `[${JSON.stringify(unit.id)}]` || (Array.isArray(visible.select.path) && visible.select.path.length === 1 && visible.select.path[0] === unit.id));
    return { ...node, ...(detached ? { visible: true } : {}), children };
  };
  return { node: content, unit, remainder: (unit.children ?? []).map(preserve).filter((child): child is SceneNode => child !== null) };
}

// Merge an UPDATE_PROPS change onto a node (props shallow-merged, style deep-merged one level)
// — the same "keep unrelated props, override the changed ones" contract commitFormat relies on.
export function mergeNodeProps(node: SceneNode, changes: { props?: Record<string, unknown>; visible?: boolean }): SceneNode {
  const currentProps = isRecord(node.props) ? node.props : {};
  const nextProps = { ...currentProps, ...(changes.props ?? {}) };
  if (isRecord(changes.props?.custom)) {
    nextProps.custom = { ...(isRecord(currentProps.custom) ? currentProps.custom : {}), ...changes.props.custom };
  }
  const currentStyle = isRecord(currentProps.style) ? currentProps.style : {};
  const changeStyle = isRecord(changes.props?.style) ? (changes.props!.style as Record<string, unknown>) : null;
  if (changeStyle) nextProps.style = { ...currentStyle, ...changeStyle };
  const next: SceneNode = { ...node, props: nextProps };
  if (changes.visible !== undefined) next.visible = changes.visible;
  return next;
}

// Connection KINDS are enum-dissolved exactly like formats/materials: the built-in seed
// (depends / reads / owns / embeds) merges with live published rows — a package adds a
// connection MEANING as DATA, zero EdgeLayer change. The EdgeLayer NEVER names a kind; it
// reads {label, tone} from the descriptor an edge's `kind` key selects (L090). The kernel
// only route-computes edges; the meaning is authored content + a render concern. The
// `tone` is the routed line's stroke colour + the label-pill colour (Weavy/Runway-grounded).
export type ConnectionKind = {
  id: string;
  label: string;
  tone: string;
  [key: string]: unknown;
};

export const CONNECTION_KINDS: ConnectionKind[] = [
  { id: 'conn:depends', label: 'Depends on', tone: '#E0A33E' },
  { id: 'conn:reads', label: 'Reads', tone: '#4B8BF4' },
  { id: 'conn:owns', label: 'Owns', tone: '#3FB27F' },
  { id: 'conn:embeds', label: 'Embeds', tone: '#8B7CF6' },
];

function connectionKindFrom(value: unknown): ConnectionKind | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const label = typeof value.label === 'string' ? value.label : null;
  const tone = typeof value.tone === 'string' ? value.tone : null;
  if (!id || !label || !tone) return null;
  return { ...value, id, label, tone };
}

export function readConnectionKinds(raw: unknown): ConnectionKind[] {
  const values = isRecord(raw) && Array.isArray(raw.connection_kinds)
    ? flattenProjectedRows(raw.connection_kinds)
    : flattenProjectedRows(raw);
  const read = values
    .map(connectionKindFrom)
    .filter((value): value is ConnectionKind => value !== null);
  const overridden = new Set(read.map((d) => d.id));
  return [...read, ...CONNECTION_KINDS.filter((d) => !overridden.has(d.id))];
}

// The descriptor an edge's `kind` selects, with a NEVER-EMPTY fallback to the first kind —
// a kindless / unknown-kind edge still renders a meaning + tone, never a blank or a crash.
export function connectionKindFor(kindId: string | undefined, kinds: ConnectionKind[]): ConnectionKind {
  return kinds.find((k) => k.id === kindId) ?? kinds[0] ?? CONNECTION_KINDS[0];
}

// Advance to the next kind in the list (wraps) — the data-driven "cycle the meaning" the
// edge label pill uses. Generic: cycles through whatever descriptors exist, names nothing.
export function nextConnectionKind(kindId: string | undefined, kinds: ConnectionKind[]): ConnectionKind {
  if (kinds.length === 0) return CONNECTION_KINDS[0];
  const index = kinds.findIndex((k) => k.id === kindId);
  return kinds[(index + 1) % kinds.length];
}

// The engine's `Visibility` is untagged `Resolved(bool) | Binding(binding-AST)` —
// a node's `visible` can be a literal bool OR a binding object the kernel resolves
// each frame from live state (see do-work/build-visibility-binding.ts).
export type SceneVisibility = boolean | { $kind: 'binding'; [key: string]: unknown };

export type SceneNodeBind = {
  feed_address: string;
  item_template_node_id: string;
  // `limit` is the INITIAL window. `page` (optional, DATA-opt-in) makes the node
  // GROW on scroll: when the surface scrolls near this feed's bottom, the surface
  // adds `page` more rows (infinite scroll). A node WITHOUT `page` stays fixed at
  // `limit` (e.g. a short "latest replies" rail). Self-describing (L090): the node
  // declares whether it grows; the materializer/surface never special-cases which.
  window?: { offset?: number; limit?: number; page?: number };
  where?: { field: string; equals: unknown };
  // Optional DATA-declared sort applied BEFORE the window slice, so the newest
  // (or DATA-chosen) records are the ones that survive `limit`. Generic (L090):
  // the engine never names a field — `by` is a dot-path the DATA supplies and
  // the comparator infers type (date string → epoch, numeric → number, else
  // locale string). Without `order`, rows keep the feed's native aggregate order
  // (grouped by subject id — NOT time), which pushes brand-new records to
  // arbitrary positions and off the visible window. A feed declares
  // `{ by: "created_at", dir: "desc" }` to always float new posts to the top.
  order?: { by: string; dir?: 'asc' | 'desc' };
};

/**
 * Open capability DATA carried inside
 * `SceneNode.props.custom.web_element.capability`.
 *
 * `editability` is the one honest cross-owner distinction: an opaque browser
 * subtree can keep a raster fallback without being mislabeled as editable.
 * Additional producer facts stay open and are carried without teaching the
 * composition kernel source-specific vocabulary.
 */
export type SceneNodeCapability = {
  editability: 'editable' | 'partial' | 'opaque';
  raster_fallback_ref?: string;
  raster_fallback_src?: string;
  limitations?: string[];
  [key: string]: unknown;
};

/** Browser-source DATA kept behind Rust NodeProps' existing `custom` owner. */
export type SceneWebElement = {
  tag_name?: string;
  namespace_uri?: string;
  attributes?: Record<string, unknown>;
  pseudo_elements?: unknown;
  computed_css?: Record<string, unknown>;
  geometry?: unknown;
  resources?: unknown;
  capability?: SceneNodeCapability;
  [key: string]: unknown;
};

export type SceneNodeCustom = Record<string, unknown> & {
  web_element?: SceneWebElement;
};

/**
 * The Rust-owned NodeProps serde boundary. Producer extensions belong under
 * `custom`; declaring unknown top-level props here would falsely promise they
 * survive composition-engine hydration.
 */
export type SceneNodeProps = {
  text?: string;
  style?: Record<string, unknown>;
  src?: string;
  handlers?: unknown;
  a11y?: unknown;
  custom?: SceneNodeCustom;
  component_id?: string;
  integrity_hash?: string;
  bundle?: string;
  instance_props?: unknown;
  artifact_dependencies?: Record<string, string>;
  things_to_put_on_screen?: unknown[];
};

export type SceneNode = {
  id: string;
  kind: string;
  props?: SceneNodeProps;
  style?: Record<string, unknown>;
  children?: SceneNode[];
  visible?: SceneVisibility;
  // Top-level reactive/structural fields the kernel owns (composition-ast types.rs). The
  // authoring surface rarely sets them, but a FULL-NODE re-author (e.g. binding a node's
  // visibility) MUST preserve them via spread — so the type declares them honestly rather
  // than silently dropping them at the boundary. `triggers` (interaction) and `visible`
  // (binding) are the reactive ones an UPDATE_PROPS delta cannot carry.
  triggers?: unknown[];
  z_index?: number | null;
  portal_owner?: string | null;
  synthetic?: boolean;
  value?: unknown;
  bindings?: CompositionBinding[];
  // Data-bind capability: a node MAY carry a bind directive to materialize children from
  // a scoped feed. The engine reads the feed at feed_address, materializes one child per
  // record by cloning item_template_node_id with a stable child id (hash of the record
  // address) so MOVE_NODE identity survives re-materialization. Engine stays blind to
  // feed_address kind/vocabulary — it is pure DATA. Materialization is windowed
  // (O(viewport)); unseen children cost zero bytes (composition-engine WASM constraint).
  bind?: SceneNodeBind;
  // Inline FSM owned by THIS node — the interactive-block primitive (to-do /
  // toggle / accordion). The kernel auto-registers it under the node's id on
  // insert (composition-ast SceneNode.fsm); a `click` handler dispatches a
  // transition to the node's own id and descendant `visible` bindings read
  // `{from:'fsm', path:<this node id>}`. In a MATERIAL template the descendant
  // bindings use the `$selfFsm` sentinel path, resolved to the minted owner id
  // at insert-time by `freshIds` (the read side is an absolute key).
  fsm?: { initial: string; states: Record<string, unknown> };
};

// Owner-declared action reference a node trigger dispatches (custom-actions
// R10/P7): pure self-describing data — the surface never names actions.
export type CompositionActionRef = {
  action_id: string;
  owner?: string;
  target?: string;
  input?: Record<string, unknown>;
};

export type CompositionTrigger = {
  event: string;
  action_ref: CompositionActionRef;
};

export type CompositionBinding = {
  property: string;
  source: Record<string, unknown>;
};

// The kernel route-computes edges; the AUTHORED edge (incl. its human
// meaning label) is content data. Extra keys (label) ride the persisted
// record; the kernel only reads the fields it knows (self-describing data).
export type EdgeConnection = {
  edge_id: string;
  source_id: string;
  target_id: string;
  source_anchor?: string;
  target_anchor?: string;
  // `kind` selects a ConnectionKind descriptor (the human MEANING: depends/reads/owns/…).
  // A self-describing key the kernel ignores; the EdgeLayer reads it to colour + label the
  // routed line. `label` is the descriptor's text, denormalised onto the persisted edge.
  kind?: string;
  label?: string;
  [key: string]: unknown;
};

export type ScenePatch =
  | { type: 'SET_ROOT'; node: SceneNode }
  // UPDATE_PROPS is a DELTA of RESOLVED values: the engine's `PropChanges.visible` is
  // `Option<bool>` (bool-only), so `visible` here is a plain `boolean`, NOT a binding.
  // A binding is a top-level `SceneNode` field (reactive, re-evaluated each frame) that
  // ONLY a FULL node (SET_ROOT / INSERT_NODE) can carry — authoring a binding via this
  // delta is rejected at decode. (This type previously lied with `SceneVisibility`,
  // which hid the conditional-visibility write-side defect — task #18.)
  | { type: 'UPDATE_PROPS'; node_id: string; changes: { props?: Record<string, unknown>; visible?: boolean } }
  | { type: 'REMOVE_SUBTREE'; node_id: string }
  | { type: 'INSERT_NODE'; parent_id: string; index: number; node: SceneNode }
  | { type: 'MOVE_NODE'; node_id: string; new_parent_id: string; new_index: number }
  | { type: 'REORDER_CHILDREN'; parent_id: string; new_order: string[] };

export type EdgeMutation =
  | ({ type: 'add' } & EdgeConnection)
  | ({ type: 'update' } & EdgeConnection)
  | { type: 'remove'; edge_id: string };

export type LayoutPatch = {
  node_id: string;
  x: number;
  y: number;
};

export type CompositionTransaction = {
  type?: 'composition-transaction';
  /** Scene SESSION this transaction addresses — the engine keys an independent
   *  kernel per session, so this editor's document NEVER shares a kernel with the
   *  shell's subscribed scene or another surface (the NodeNotFound save-storm root).
   *  Opaque caller-chosen DATA; the surface uses its document address. */
  session?: string;
  set_scene?: SceneNode;
  scene_patches?: ScenePatch[];
  set_edges?: EdgeConnection[];
  edge_mutations?: EdgeMutation[];
  layout_patches?: LayoutPatch[];
  camera?: CanvasCamera;
  viewport?: { w: number; h: number };
  /** Ephemeral host-measured wrapped text heights (node_id → px). The engine has
   *  no fonts; the host measures each text block's real DOM height and feeds it so
   *  the engine reflows the blocks below in its own layout pass. Never persisted. */
  text_measurements?: { node_id: string; height: number; natural_width?: number }[];
};

export type SceneFrame = {
  rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

export type VisibleEdgeRoute = {
  edge_id: string;
  source_id?: string;
  target_id?: string;
  points: Array<{ x: number; y: number }>;
};

export type CompositionSnapshot = {
  tree: SceneNode | null;
  authored_tree?: SceneNode | null;
  frames: Record<string, SceneFrame>;
  camera: CanvasCamera;
  visible_edge_routes: VisibleEdgeRoute[];
};

export type MaterialDescriptor = {
  id: string;
  label: string;
  match_terms: string[];
  node: SceneNode;
  // Optional self-describing display DATA (L090): a glyph and a section name the
  // blind insert menu shows verbatim. The renderer never maps id -> icon/group;
  // whatever a descriptor carries is what shows, with one generic fallback.
  icon?: string;
  group?: string;
};

// One self-describing content shape (correction #4): the engine root's
// children verbatim plus the camera. There is no document/page/title unit —
// the things that feel like pages are just nodes among these children.
export type CompositionContent = {
  children: SceneNode[];
  edges?: EdgeConnection[];
  camera?: CanvasCamera;
  // Reusable component definitions live IN the document (file-scoped, like Figma),
  // persisted by the existing document write path — no separate engine-write. The
  // resolver expands instances against these; the slash menu offers them.
  definitions?: ComponentDefinitionRecord[];
};

export type CompositionRuntimeConfig = {
  partition_label: string;
  // The empty-block placeholder copy (Society — editor chrome text). DATA-driven so
  // the prompt can be reworded/localized without a source edit (Physics vs Society);
  // absent ⇒ the surface's capable default (L083). Shown ONLY on the focused empty
  // block, never on every empty block (Notion behaviour).
  block_placeholder?: string;
};

// The generated descriptor may omit its partition on a hosted surface. In that
// case the published runtime-config row is required, and callers wait for it.
export function readCompositionRuntimeConfig(
  raw: unknown,
  servingPartitionLabel: string | undefined,
): CompositionRuntimeConfig | null {
  const first = flattenProjectedRows(raw).find((value) => isRecord(value) && typeof value.partition_label === 'string');
  const published = isRecord(first) && typeof first.partition_label === 'string' && first.partition_label.trim().length > 0
    ? first.partition_label.trim()
    : null;
  const placeholder = isRecord(first) && typeof first.block_placeholder === 'string' && first.block_placeholder.trim().length > 0
    ? first.block_placeholder.trim()
    : undefined;
  const partition = published ?? (typeof servingPartitionLabel === 'string' && servingPartitionLabel.trim() ? servingPartitionLabel.trim() : null);
  return partition ? { partition_label: partition, block_placeholder: placeholder } : null;
}

export function readMaterialDescriptors(raw: unknown): MaterialDescriptor[] {
  const values = isRecord(raw) && Array.isArray(raw.materials)
    ? flattenProjectedRows(raw.materials)
    : flattenProjectedRows(raw);
  return values.map(materialDescriptorFrom).filter((value): value is MaterialDescriptor => value !== null);
}

export function readCompositionContent(raw: unknown): CompositionContent | null {
  for (const value of flattenProjectedRows(raw)) {
    if (isCompositionContent(value)) return value;
    // Pre-correction-#4 rows carried {id,title,scene,...} records — translate
    // their scenes into children once so existing live data keeps rendering.
    if (isRecord(value) && isSceneNode(value.scene)) {
      return { children: [value.scene as SceneNode], camera: undefined };
    }
  }
  return null;
}

// Placeable surfaces become insertable materials: choosing one inserts a
// Component node whose component_id is the surface's material target. The
// list comes from generic published placeable-surface records (L090 — this
// package never maintains its own surface list).
export function readPlaceableSurfaceMaterials(raw: unknown): MaterialDescriptor[] {
  // Schema-level frame defaults ride the SAME stream ('composition-material-defaults').
  const schemaFrameDefaultsProbe = readMaterialFrameDefaultsOrNull(raw);
  const schemaFrameDefaults = schemaFrameDefaultsProbe;
  return flattenProjectedRows(raw)
    .map((row) => {
      const payload = isRecord(row) && isRecord(row.payload) ? row.payload : row;
      if (!isRecord(payload) || payload.kind !== 'placeable-surface') return null;
      return placeableSurfaceMaterial(payload, schemaFrameDefaults);
    })
    .filter((value): value is MaterialDescriptor => value !== null);
}

/** Pure shared payload → composition material translation; insertion remains the surface owner. */
export function placeableSurfaceMaterial(raw: unknown, schemaFrameDefaults?: { width: number; height: number } | null): MaterialDescriptor | null {
      const payload = readDocumentsPlaceableSurfacePayload(raw);
      if (!payload) return null;
      const legacy = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const label = payload.title ?? (typeof legacy.label === 'string' ? legacy.label : null) ?? payload.materialTarget ?? payload.target ?? null;
      const target = payload.materialTarget ?? null;
      const id = payload.id ?? target;
      if (!label || !target || !id) return null;
      // package_entry rides along (self-describing data, L090) so a blind
      // renderer can mount the live entry bytes without any registry. The ui
      // reader normalizes the reference to camelCase {packageName, entryName},
      // but the NODE-level dialect read by every renderer (this package's
      // ComponentNodeSurface, screen-arrangement WorkspaceShell,
      // access-scoped-content, account-session, item-record, group-page) is
      // snake_case {package_name, entry_name}. Serialize CANONICALLY snake so
      // an inserted node speaks the same dialect as every reader; the render
      // side stays tolerant of both (2026-08-22 label-only regression fix).
      const packageEntry = payload.packageEntry ?? null;
      const packageEntryNode = packageEntry
        ? { package_name: packageEntry.packageName, entry_name: packageEntry.entryName }
        : null;
      return {
        id: `placeable:${id}`,
        label,
        match_terms: [label, ...label.toLowerCase().split(/\s+/)],
        group: 'Surfaces',
        ...(typeof payload.icon === 'string' ? { icon: payload.icon } : {}),
        node: {
          id: `node:surface:${id}`,
          kind: 'Component',
          props: {
            component_id: target,
            // Carry the surface's OWN self-described mount contract verbatim
            // (L090) so a blind renderer can compose real slots correctly: its
            // declared fit, its input data, and its routing/material targets —
            // not just the package bytes. Omitting these force-fills every
            // surface and starves mounted slots of their invocation context
            // (convergence 2026-06-20, F5/F8).
            custom: {
              label,
              ...(packageEntryNode ? { package_entry: packageEntryNode } : {}),
              ...(payload.surfaceInput ? { surface_input: payload.surfaceInput } : {}),
              ...(typeof legacy.frame_fit === 'string' ? { frame_fit: legacy.frame_fit } : {}),
              material_target: target,
              ...(typeof payload.target === 'string' ? { target: payload.target } : {}),
            },
            // Initial size is node DATA the engine lays out (resizable like
            // any node). Precedence: descriptor width/height VERBATIM → the
            // descriptor's own frame_defaults → the schema-level
            // composition-material-defaults record → 720x480, a capable
            // DEFAULT used only when no data declares a size (without any
            // size the engine measures an empty Component as ~0 and the
            // mounted surface renders invisibly).
            style: {
              width: typeof legacy.width === 'number'
                ? legacy.width
                : (frameDefaultsFromRecord(legacy) ?? schemaFrameDefaults ?? { width: 720, height: 480 }).width,
              height: typeof legacy.height === 'number'
                ? legacy.height
                : (frameDefaultsFromRecord(legacy) ?? schemaFrameDefaults ?? { width: 720, height: 480 }).height,
            },
          },
          visible: true,
          children: [],
        },
      } satisfies MaterialDescriptor;
}

type DocumentsPlaceableSurfacePayload = {
  id?: string; title?: string; target: string | null; materialTarget: string | null; icon?: string;
  packageEntry: { packageName: string; entryName: string } | null; surfaceInput?: Record<string, unknown>;
};

/** Documents-local admission projection; DOM transport parsing remains owned by UI. */
function readDocumentsPlaceableSurfacePayload(value: unknown): DocumentsPlaceableSurfacePayload | null {
  let parsed: unknown = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { return null; } }
  if (!isRecord(parsed)) return null;
  const text = (candidate: unknown): string | null => typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  const rawEntry = parsed.packageEntry ?? parsed.package_entry;
  const packageName = isRecord(rawEntry) ? text(rawEntry.packageName ?? rawEntry.package_name) : null;
  const entryName = isRecord(rawEntry) ? text(rawEntry.entryName ?? rawEntry.entry_name) : null;
  const surfaceInput = parsed.surfaceInput ?? parsed.surface_input;
  return {
    id: text(parsed.id) ?? undefined,
    title: text(parsed.title) ?? text(parsed.label) ?? undefined,
    target: text(parsed.target) ?? text(parsed.address),
    materialTarget: text(parsed.materialTarget) ?? text(parsed.material_target),
    icon: text(parsed.icon) ?? undefined,
    packageEntry: packageName && entryName ? { packageName, entryName } : null,
    ...(isRecord(surfaceInput) ? { surfaceInput } : {}),
  };
}

// Pure keyboard-nav index step for the insert menu: wraps within [0, count).
// count <= 0 -> 0. Down = +1, Up = -1. Wrapping matches Linear/Raycast menus.
export function nextMenuIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

export function materialMatchesQuery(material: MaterialDescriptor, query: string): boolean {
  const normalized = query.replace(/^\//, '').trim().toLowerCase();
  if (!normalized) return false;
  return material.match_terms.some((term) => term.toLowerCase().startsWith(normalized));
}

function isMaterialDescriptor(value: unknown): value is MaterialDescriptor {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.label === 'string'
    && Array.isArray(value.match_terms)
    && isSceneNode(value.node);
}

function materialDescriptorFrom(value: unknown): MaterialDescriptor | null {
  if (isMaterialDescriptor(value)) return value;
  if (!isRecord(value) || !isSceneNode(value.node)) return null;
  const label = typeof value.label === 'string' ? value.label : null;
  const id = typeof value.id === 'string'
    ? value.id
    : typeof value.material === 'string'
      ? value.material
      : null;
  if (!label || !id) return null;
  const terms = Array.isArray(value.match_terms)
    ? value.match_terms.filter((term): term is string => typeof term === 'string')
    : typeof value.search === 'string'
      ? value.search.split(/\s+/).filter(Boolean)
      : [label];
  return {
    id,
    label,
    match_terms: terms,
    node: value.node,
    ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
    ...(typeof value.group === 'string' ? { group: value.group } : {}),
  };
}

function isCompositionContent(value: unknown): value is CompositionContent {
  if (!isRecord(value)) return false;
  return Array.isArray(value.children) && value.children.every(isSceneNode);
}

function isSceneNode(value: unknown): value is SceneNode {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.kind === 'string'
    && (!('children' in value) || Array.isArray(value.children));
}

export function flattenProjectedRows(raw: unknown): unknown[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) => {
    if (!isRecord(value) || !('payload' in value)) return [value];
    return Array.isArray(value.payload) ? value.payload : [value.payload];
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A node authors its own ORIGIN (its top-left x/y is meaningful, so a
// `layout_patch` applies) iff its PARENT arranges children absolutely — the
// engine's `LayoutMode::Absolute` (serde lowercase `"absolute"`). Flex/split
// parents position children themselves, so sending an origin patch for such a
// child fights the engine, which is the only layout truth. Root-level nodes are
// flow (the rail stacks them as pages), so they author no origin until a future
// absolute canvas wraps them. This is read STRUCTURALLY from the tree, never by
// diffing async snapshot coordinates (convergence 2026-06-20 Q1).
//
// Convention: this surface stores style under `props.style` (the engine resolves
// `props.style.layout.mode` → `LayoutConfig.mode`); we also tolerate a top-level
// `style` for robustness.
export function nodeAuthorsOrigin(tree: SceneNode | null, nodeId: string): boolean {
  const parent = findParentNode(tree, nodeId);
  if (!parent) return false;
  return layoutModeOf(parent) === 'absolute';
}

function findParentNode(node: SceneNode | null, nodeId: string): SceneNode | null {
  if (!node || !node.children) return null;
  for (const child of node.children) {
    if (child.id === nodeId) return node;
    const found = findParentNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function layoutModeOf(node: SceneNode): string | undefined {
  const props = isRecord(node.props) ? node.props : undefined;
  const style = props && isRecord(props.style)
    ? props.style
    : isRecord(node.style)
      ? node.style
      : undefined;
  const layout = style && isRecord(style.layout) ? style.layout : undefined;
  return layout && typeof layout.mode === 'string' ? layout.mode.toLowerCase() : undefined;
}

// Package-published default frame size for inserted surface materials
// ('composition-material-defaults' records). Kept as DATA a package can
// override; readPlaceableSurfaceMaterials prefers a per-descriptor size.
export type MaterialFrameDefaults = {
  width: number;
  height: number;
};

export function readMaterialFrameDefaults(raw: unknown): MaterialFrameDefaults {
  return readMaterialFrameDefaultsOrNull(raw) ?? { width: 480, height: 320 };
}

function readMaterialFrameDefaultsOrNull(raw: unknown): MaterialFrameDefaults | null {
  for (const value of flattenProjectedRows(raw)) {
    const payload = isRecord(value) && isRecord(value.payload) ? value.payload : value;
    if (!isRecord(payload) || payload.kind !== 'composition-material-defaults') continue;
    const defaults = frameDefaultsFromRecord(payload);
    if (defaults) return defaults;
  }
  return null;
}

// A record's own frame size: an explicit frame_defaults object, or width/height
// directly on the record. Null when neither declares a positive finite pair.
function frameDefaultsFromRecord(value: Record<string, unknown>): MaterialFrameDefaults | null {
  const source = isRecord(value.frame_defaults) ? value.frame_defaults : value;
  const width = typeof source.width === 'number' && Number.isFinite(source.width) && source.width > 0 ? source.width : null;
  const height = typeof source.height === 'number' && Number.isFinite(source.height) && source.height > 0 ? source.height : null;
  return width !== null && height !== null ? { width, height } : null;
}

/** Materialize children from a bound feed. Given a node with a bind directive,
 *  read records from feedRows and clone the item_template for each record.
 *  Field bindings in template nodes (props.text.field, props.image.field, etc.)
 *  are resolved against each record using dot-path access.
 *  Child id is a stable hash of (sceneAddress, nodeId, recordAddress) so
 *  MOVE_NODE identity survives re-materialization. O(window), not O(total). */
export function materializeBoundFeedChildren(
  node: SceneNode,
  feedRows: unknown[],
  sceneAddress: string,
  templateLookup: (templateId: string) => SceneNode | null,
  /** The caller's clock, for `relative-time` field formatting. Required and with no
   *  default: this module compiles into Documents' own targets, which the engine
   *  replays against the log, so the clock has to arrive from outside. A target
   *  passes `readTrustedRuntimeClockMs(context)`; a browser surface passes its own,
   *  which the log records as the input it is. */
  nowMs: number,
  extraLimit = 0,
): SceneNode[] {
  if (!node.bind) return [];
  const { item_template_node_id: templateId, window } = node.bind;
  const template = templateLookup(templateId);
  if (!template) return [];

  // The rows handed in ARE the bound feed's records — the feed was already
  // scoped to feed_address by the reader (useBitfieldData(feed_address)); there
  // is no per-row `address` field to match against. Take every record row,
  // optionally narrowed by a generic DATA-supplied equality predicate.
  const where = node.bind.where;
  const records = feedRows.filter((row) => {
    if (!isRecord(row)) return false;
    if (!where) return true;
    return resolveFieldPath(row as Record<string, unknown>, where.field) === where.equals;
  });

  // DATA-declared ordering BEFORE the window slice, so the newest (or otherwise
  // DATA-chosen) records survive `limit`. Generic: the field is a DATA dot-path
  // and the comparator infers type (date → epoch, numeric → number, else
  // string). Without `order`, rows keep native aggregate order (subject-id
  // grouped — NOT time), which strands new records off the visible window.
  const order = node.bind.order;
  if (order?.by) {
    const dir = order.dir === 'asc' ? 1 : -1; // default newest-first
    records.sort((a, b) => {
      const av = resolveFieldPath(a as Record<string, unknown>, order.by);
      const bv = resolveFieldPath(b as Record<string, unknown>, order.by);
      return compareOrderValues(av, bv) * dir;
    });
  }

  // Apply window (offset + limit + runtime scroll-grow extra). The base limit is
  // the DATA-declared initial window; the surface adds `extraLimit` as the user
  // scrolls (only for nodes that opted into growth via window.page — the surface
  // never grows a fixed-window node, so extraLimit is 0 for those).
  const offset = window?.offset ?? 0;
  const baseLimit = window?.limit ?? records.length;
  const limit = baseLimit + Math.max(0, extraLimit);
  const windowed = records.slice(offset, offset + limit);

  // Clone template for each record with a stable identity-hashed id and field
  // resolution. Identity comes from the record's own stable key (item_ref / id /
  // ref / address) so MOVE_NODE identity survives re-materialization; fall back
  // to the window index only when the record carries no stable key.
  return windowed.map((row, index) => {
    const r = row as Record<string, unknown>;
    const recordKey = typeof r.item_ref === 'string' ? r.item_ref
      : typeof r.id === 'string' ? r.id
      : typeof r.ref === 'string' ? r.ref
      : typeof r.address === 'string' ? r.address
      : `idx-${index}`;
    // Stable hash: deterministic id for the record so identity persists across re-renders
    const hashInput = `${sceneAddress}:${node.id}:${recordKey}`;
    const childId = `bound-${simpleHash(hashInput)}`;
    return cloneNodeWithFieldResolution(template, childId, r, nowMs);
  });
}

/** Simple deterministic hash for stable child ids. Not cryptographic; just needs
 *  to produce consistent output for the same input (no collisions within a scene). */
function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + code;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/** Resolve a dot-path value from a record (e.g., "fields.title" -> record.fields.title) */
/** Presentation formats a scene's field-binding can select by DATA. Generic:
 *  the formatter never knows record kinds — it transforms one scalar. */
function formatBoundValue(value: unknown, format: string, nowMs: number): unknown {
  if (format === 'relative-time' || format === 'date') {
    const t = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    if (!t || Number.isNaN(t.getTime())) return value;
    if (format === 'date') return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    // `nowMs` is handed in, never read here: this module compiles into Documents'
    // own targets, which the engine replays against the log, and "2h ago" computed
    // from a clock the module reached for itself replays differently every hour.
    const s = Math.max(0, (nowMs - t.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (format === 'handle') {
    // A ref like `actor:local` / `actor:abc...` reads as a member handle: the
    // segment after the last ':', trimmed of trailing timestamps, never the
    // raw internal ref (L114 — internal vocabulary stays out of product UI).
    const raw = String(value ?? '');
    const tail = raw.split(':').pop() ?? raw;
    const clean = tail.replace(/\d{4}-\d{2}-\d{2}T.*$/, '').trim();
    return clean ? clean : 'member';
  }
  return value;
}

/** Type-inferring comparator for DATA-declared feed ordering. Returns <0 when a
 *  sorts before b in ASCENDING order (the caller multiplies by -1 for desc).
 *  Missing/blank values always sort LAST regardless of direction so brand-new
 *  records lacking the sort field never displace real ones. Generic: no field
 *  names, no record kinds — it compares two opaque scalars. */
function compareOrderValues(a: unknown, b: unknown): number {
  const aMissing = a === undefined || a === null || a === '';
  const bMissing = b === undefined || b === null || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  // Date strings (ISO) and epoch numbers both compare as time when parseable.
  const at = typeof a === 'string' ? Date.parse(a) : NaN;
  const bt = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isNaN(at) && !Number.isNaN(bt)) return at - bt;
  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return String(a).localeCompare(String(b));
}

function resolveFieldPath(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = record;
  for (const part of parts) {
    if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Deep clone a node with a new id and resolve field bindings against a record.
 *  Nodes with props containing {field: "path.to.field"} have that field resolved
 *  and injected into the cloned node. Children are recursively cloned. */
function cloneNodeWithFieldResolution(
  node: SceneNode,
  newId: string,
  record: Record<string, unknown>,
  nowMs: number,
): SceneNode {
  const cloned = { ...node, id: newId };

  // Recursively resolve field bindings in props
  if (node.props && typeof node.props === 'object') {
    cloned.props = resolvePropsFieldBindings(node.props as Record<string, unknown>, record, nowMs);
  }

  // Recursively clone children
  if (node.children) {
    cloned.children = node.children.map((child) =>
      cloneNodeWithFieldResolution(child, `${newId}-${child.id}`, record, nowMs),
    );
  }

  return cloned;
}

/** Materialize bound feed children in a scene. Recursively walks the node tree,
 *  calls materializeBoundFeedChildren for any node with a bind directive,
 *  and replaces its children with the materialized ones. */
function materializeSceneBoundFeeds(
  node: SceneNode,
  allFeedRows: unknown[],
  sceneAddress: string,
  nodeMap: Map<string, SceneNode>,
  extraLimitByNode: Record<string, number>,
  nowMs: number,
): SceneNode {
  // Materialize children if this node has a bind directive
  let children = node.children;
  if (node.bind && children) {
    children = materializeBoundFeedChildren(
      { ...node, children }, // Pass node with current children as fallback
      allFeedRows,
      sceneAddress,
      (templateId) => nodeMap.get(templateId) ?? null,
      nowMs,
      extraLimitByNode[node.id] ?? 0,
    );
  } else if (children && children.length > 0) {
    // Recursively materialize child nodes
    children = children.map((child) =>
      materializeSceneBoundFeeds(child, allFeedRows, sceneAddress, nodeMap, extraLimitByNode, nowMs),
    );
  }

  return { ...node, children };
}

/** Process a composition content's scene nodes to materialize all bound feeds.
 *  Returns a new CompositionContent with materialized feed children. */
export function materializeCompositionBoundFeeds(
  content: CompositionContent | null,
  allFeedRows: unknown[],
  sceneAddress: string,
  /** The caller's clock, for `relative-time` field formatting. See
   *  `materializeBoundFeedChildren` for why it has no default. */
  nowMs: number,
  extraLimitByNode: Record<string, number> = {},
): CompositionContent | null {
  if (!content) return null;
  // Defensive: allFeedRows can arrive null before the feed data loads; a null
  // reaching materializeBoundFeedChildren.filter crashes the surface.
  const safeFeedRows = Array.isArray(allFeedRows) ? allFeedRows : [];

  // Build a map of all nodes in the scene for template lookup
  const nodeMap = new Map<string, SceneNode>();
  function indexNodes(node: SceneNode) {
    nodeMap.set(node.id, node);
    if (node.children) {
      node.children.forEach(indexNodes);
    }
  }
  (content.children ?? []).forEach(indexNodes);

  // Materialize bound feeds in all root children
  const children = (content.children ?? []).map((child) =>
    materializeSceneBoundFeeds(child, safeFeedRows, sceneAddress, nodeMap, extraLimitByNode, nowMs),
  );

  return { ...content, children };
}

/** A growable bound feed and how many records it currently matches. The surface
 *  uses this to decide, on scroll, which nodes can grow and whether more rows
 *  remain (matched > current window). Generic: it reads the same DATA `bind`
 *  directives the materializer does; it never names a feed kind or node. */
export type GrowableBoundFeed = {
  nodeId: string;
  page: number;      // rows to add per scroll-grow (window.page)
  baseLimit: number; // the DATA-declared initial window
  matched: number;   // total records the where-predicate matches
};

/** Walk a scene and return every bound node that opted into scroll-growth
 *  (window.page set), with its current match count. */
export function collectGrowableBoundFeeds(
  content: CompositionContent | null,
  allFeedRows: unknown[],
): GrowableBoundFeed[] {
  if (!content) return [];
  // allFeedRows can be null on the first render (the feed data has not loaded
  // yet) — guard so the reduce never runs on null (crashed the whole surface).
  const rows = Array.isArray(allFeedRows) ? allFeedRows : [];
  const out: GrowableBoundFeed[] = [];
  const visit = (node: SceneNode) => {
    const page = node.bind?.window?.page;
    if (node.bind && typeof page === 'number' && page > 0) {
      const where = node.bind.where;
      const matched = rows.reduce<number>((n, row) => {
        if (!isRecord(row)) return n;
        if (!where) return n + 1;
        return resolveFieldPath(row as Record<string, unknown>, where.field) === where.equals ? n + 1 : n;
      }, 0);
      out.push({ nodeId: node.id, page, baseLimit: node.bind.window?.limit ?? matched, matched });
    }
    node.children?.forEach(visit);
  };
  (content.children ?? []).forEach(visit);
  return out;
}

/** Recursively resolve field bindings in a props object.
 *  Looks for {field: "path"} patterns and replaces them with actual values. */
function resolvePropsFieldBindings(
  props: Record<string, unknown>,
  record: Record<string, unknown>,
  nowMs: number,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) {
      resolved[key] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      // Check if this is a field binding directive
      if (typeof obj.field === 'string') {
        // Resolve to the PLAIN value: renderers read props (e.g. Text's `text`)
        // as scalars — leaving a {field, value} wrapper in place renders empty.
        // Fall back to the directive's declared default when the record lacks it.
        const fieldValue = resolveFieldPath(record, obj.field);
        const plain = fieldValue !== undefined && fieldValue !== null ? fieldValue : (obj.default ?? '');
        // Optional presentation format selected by DATA (`format` on the directive) —
        // the translation boundary (L098): raw record vocabulary (actor refs, ISO
        // timestamps) never reaches the human unless the scene author asks for raw.
        resolved[key] = typeof obj.format === 'string' ? formatBoundValue(plain, obj.format, nowMs) : plain;
      } else {
        // Recursively resolve nested objects
        resolved[key] = resolvePropsFieldBindings(obj, record, nowMs);
      }
    } else if (Array.isArray(value)) {
      // Recursively resolve arrays of objects
      resolved[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? resolvePropsFieldBindings(item as Record<string, unknown>, record, nowMs)
          : item,
      );
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}
