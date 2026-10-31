// tools/turn-frames-into-slides/read-data/stroke-style.ts
//
// The stroke-style leaf — pure, zero I/O, framework-agnostic. Turns ANY polyline (a connector,
// a border rectangle, a divider, an axis) into an SVG path `d` under a self-describing
// `StrokeStyle` DATA descriptor. The generative axis this adds is ROUGHNESS: a numeric parameter
// that perturbs the path into a hand-drawn / pencil / sketch line. roughness 0 → a byte-identical
// crisp path (zero regression for every existing line); roughness > 0 → a deterministic bowed +
// jittered path (seeded per line, so a given line always wobbles the SAME way — no re-render
// jitter, the Excalidraw/rough.js discipline).
//
// This is the L069 primitive the "sketch look" is a DATA configuration of: color / width / dash
// were ALREADY data on the board (item-appearance's open bag); roughness + a stroke CATALOG make
// EVERY line an arbitrary brushstroke with ZERO per-style code. A new style ("wavy", "double",
// "neon") is one STROKE_STYLES row (deletion test: delete pencil/marker and a dropped-in style
// DATA still renders). The blind renderer (ConnectorLayer / a rough border) reads the descriptor
// and calls `strokePathD`; it never enumerates a style name (L090). Physics = the jitter math
// here; Society = which style DATA a theme selects.

// The style descriptor + polyline points are UNTRUSTED persisted DATA. A hand-crafted
// `roughness`/`bowing` of Number.MAX_VALUE (or NaN), or a point coord of MAX_VALUE, would
// otherwise amplify into a non-finite SVG `d` ("M Infinity …" / "M NaN …") that the blind
// renderer emits verbatim. Two bounds close it: amplitudes are capped to MAX_AMPLITUDE, and
// every emitted coordinate passes through the finiteCoord SSOT (non-finite → 0, huge → ±limit).
import { finiteCoord } from './finite-coord.ts';

/** Ceiling for the jitter/bow amplitude. Real styles are < 5px; this only defuses a hostile
 *  MAX_VALUE (which would otherwise place a knot at ~1e308). A non-finite/negative amplitude
 *  falls back to `fallback` (the crisp/neutral default). */
const MAX_AMPLITUDE = 1000;
const clampAmplitude = (v: number, fallback: number): number =>
  Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_AMPLITUDE) : fallback;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A self-describing stroke descriptor. Every field is optional DATA; the renderer applies what
 *  is present and falls back to crisp defaults. `roughness`/`bowing` are the new hand-drawn axes. */
export interface StrokeStyle {
  /** Perpendicular jitter amplitude in px (0 = crisp). ~1.5 = pencil, ~4 = very rough. */
  readonly roughness?: number;
  /** How far segment midpoints bow out, as a fraction of `roughness` (default 1). 0 = straight-but-jittered. */
  readonly bowing?: number;
  /** Draw the line twice with independent jitter for the layered pencil look (default when roughness>0). */
  readonly doubleStroke?: boolean;
}

/** Deterministic PRNG (mulberry32) — same seed → same sequence, so a line's wobble is stable
 *  across renders. Physics: an integer state → a uniform [0,1). Society names nothing here. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (a line's memberId) → a seed, so every line has its own wobble. */
export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Perturb a polyline into a hand-drawn one: each INTERIOR vertex is jittered, and each segment
 *  bows out at its midpoint (perpendicular offset). Endpoints are kept EXACT so a rough connector
 *  still touches both nodes and a rough border still closes. Returns the ordered path knots
 *  (vertices + bowed midpoints) to be drawn as a smooth quadratic path. Pure + deterministic. */
export function roughenPolyline(points: readonly Point[], roughness: number, bowing: number, rand: () => number): Point[] {
  if (roughness <= 0 || points.length < 2) return points.slice();
  const jitter = () => (rand() * 2 - 1) * roughness;
  const knots: Point[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    // Keep the very first/last endpoint exact; jitter other shared vertices once.
    const start = i === 0 ? a : { x: a.x + jitter(), y: a.y + jitter() };
    if (i === 0) knots.push(start);
    // Perpendicular unit for the segment → bow the midpoint out of line (the hand-drawn arc).
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const bow = (rand() * 2 - 1) * roughness * bowing;
    const mid = { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow };
    const end = i === points.length - 2 ? b : { x: b.x + jitter(), y: b.y + jitter() };
    knots.push(mid, end);
  }
  return knots;
}

/** Build an SVG `d` from ordered knots. With roughness 0 → a crisp polyline (`M L L …`), byte-
 *  identical to a hand-written path so unstyled lines never change. With knots from
 *  `roughenPolyline` (vertex, midpoint, vertex, …) → a smooth quadratic path threading the bows. */
function knotsToPath(points: readonly Point[], smooth: boolean): string {
  if (points.length === 0) return '';
  if (!smooth || points.length < 3) {
    return `M ${fmt(points[0])} ` + points.slice(1).map((p) => `L ${fmt(p)}`).join(' ');
  }
  // points = [v0, m0, v1, m1, v2, …]: quadratic through each (control = midpoint, end = vertex).
  let d = `M ${fmt(points[0])}`;
  for (let i = 1; i + 1 < points.length; i += 2) d += ` Q ${fmt(points[i])} ${fmt(points[i + 1])}`;
  return d;
}

const fmt = (p: Point): string => `${round(p.x)} ${round(p.y)}`;
// finiteCoord BEFORE rounding: an untrusted point coord (or an amplified jitter) of NaN/±Infinity/
// MAX_VALUE must never reach the SVG `d` string as "NaN"/"Infinity" — clamp to a finite board coord.
const round = (n: number): number => Math.round(finiteCoord(n) * 100) / 100;

/**
 * The one call every line renderer makes: given the polyline geometry, a {@link StrokeStyle}, and
 * a stable `seed`, return the SVG path `d` string(s). roughness 0 → one crisp path; roughness > 0
 * → one (or two, for `doubleStroke`) hand-drawn quadratic paths. Deterministic for a given seed.
 */
export function strokePathD(points: readonly Point[], style: StrokeStyle, seed: number): string[] {
  // Amplitudes are UNTRUSTED DATA — a MAX_VALUE/NaN roughness/bowing is bounded (or dropped to the
  // crisp default) before it multiplies the jitter, so a knot can never land at ~1e308.
  const roughness = clampAmplitude(style.roughness ?? 0, 0);
  if (roughness <= 0 || points.length < 2) return [knotsToPath(points, false)];
  const bowing = clampAmplitude(style.bowing ?? 1, 1);
  const double = style.doubleStroke ?? true;
  const rand = mulberry32(seed);
  const first = knotsToPath(roughenPolyline(points, roughness, bowing, rand), true);
  if (!double) return [first];
  // Second pass with a decorrelated seed → the layered two-line pencil look.
  const rand2 = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const second = knotsToPath(roughenPolyline(points, roughness, bowing, rand2), true);
  return [first, second];
}

/** The two barbs of an OPEN arrowhead as a polyline `[barbA, tip, barbB]` — a V through the tip,
 *  pointing in the direction from `from` → `tip`. Fed to `strokePathD` so a hand-drawn connector's
 *  arrowhead wobbles to match its line (the crisp `<marker>` triangle is replaced for a rough line —
 *  the Excalidraw discipline: the WHOLE arrow is hand-drawn, head included). Pure + deterministic:
 *  `size` = barb length px, `spread` = half-angle as a fraction (0.55 ≈ a natural ~28° barb). A
 *  degenerate direction (from == tip) yields an empty ring (nothing to draw). */
export function arrowheadPoints(tip: Point, from: Point, size = 12, spread = 0.55): Point[] {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return [];
  const ux = dx / len;
  const uy = dy / len;
  const base = { x: tip.x - ux * size, y: tip.y - uy * size };
  const px = -uy * size * spread;
  const py = ux * size * spread;
  return [{ x: base.x + px, y: base.y + py }, tip, { x: base.x - px, y: base.y - py }];
}

// ── DATA catalog: named brushstroke styles the board offers (a new style is ONE row) ──

/** One selectable brushstroke — DATA the appearance system maps to a control option (L090). */
export interface StrokeStyleDef {
  readonly id: string;
  readonly label: string;
  /** Roughness applied when this style is chosen (0 = crisp). */
  readonly roughness: number;
  /** SVG `stroke-dasharray` when this style is dashed/dotted (undefined = solid). */
  readonly dash?: string;
  readonly bowing?: number;
}

export const STROKE_STYLES: readonly StrokeStyleDef[] = [
  { id: 'solid', label: 'Solid', roughness: 0 },
  { id: 'dashed', label: 'Dashed', roughness: 0, dash: '7 5' },
  { id: 'dotted', label: 'Dotted', roughness: 0, dash: '1 6' },
  { id: 'pencil', label: 'Pencil (sketch)', roughness: 1.6, bowing: 1 },
  { id: 'marker', label: 'Marker', roughness: 0.8, bowing: 0.5 },
  { id: 'sketch', label: 'Rough sketch', roughness: 3.2, bowing: 1.4 },
] as const;

export function strokeStyleById(id: string | undefined): StrokeStyleDef {
  return STROKE_STYLES.find((s) => s.id === id) ?? STROKE_STYLES[0];
}

/** The fully-resolved line texture a renderer consumes: the three Physics outputs of a brushstroke. */
export interface ResolvedStroke {
  readonly roughness: number;
  readonly bowing: number;
  /** SVG `stroke-dasharray` or undefined (solid). */
  readonly dash?: string;
}

/** The ONE resolver (SSOT) turning a NAMED brushstroke choice + optional raw per-line overrides into
 *  the three Physics outputs `{roughness, bowing, dash}` every line renderer (live ConnectorLayer AND
 *  the SVG export) consumes. Precedence, per axis: a positive raw override wins, else the named
 *  style's value. So a board picks "Pencil"/"Marker"/"Sketch" as ONE DATA axis (roughness AND bowing
 *  AND dash flow together — the catalog is finally distinguishable), while a per-line escape hatch can
 *  still nudge one axis. An unknown/absent id → the crisp `solid` style, so an un-themed line stays
 *  byte-identical. A brand-new brushstroke is one STROKE_STYLES row, zero renderer change (L090). */
export function resolveStroke(
  styleId: string | undefined,
  rawRoughness?: number,
  rawBowing?: number,
  rawDashed?: boolean,
): ResolvedStroke {
  const def = strokeStyleById(styleId);
  return {
    // A raw override is UNTRUSTED — cap a positive amplitude to MAX_AMPLITUDE (MAX_VALUE → bounded);
    // NaN/≤0 falls through to the trusted catalog default (`> 0`/`>= 0` already excludes NaN).
    roughness: typeof rawRoughness === 'number' && rawRoughness > 0 ? Math.min(rawRoughness, MAX_AMPLITUDE) : def.roughness,
    bowing: typeof rawBowing === 'number' && rawBowing >= 0 ? Math.min(rawBowing, MAX_AMPLITUDE) : def.bowing ?? 1,
    dash: rawDashed === true ? '7 5' : def.dash,
  };
}
