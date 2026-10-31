// tools/turn-frames-into-slides/read-data/board-svg.ts
//
// =============================================================================
// PURPOSE — the board EXPORT CONTRACT: a pure `BoardItem[] -> SVG string`.
// =============================================================================
//
// A board is only useful if it can LEAVE the app. Every incumbent canvas exports
// to a portable vector artifact; this is that artifact's serializer.
//
// Codex GPT-5.5 (high reasoning) + the adversarial gauntlet converged on
// "model -> SVG" as the export CONTRACT (over `foreignObject` DOM-snapshot or
// canvas model-draw) because it is the ONLY approach that is faithful AND fully
// deterministic / unit-testable: painting depends on fonts + machine; the DATA
// model is exact. PNG is just `Image(svg) -> canvas.drawImage -> toBlob` layered
// on this same string later (#143). This file is the provable core.
//
// L090 / L069 — BLIND GENERIC HANDLER: this serializer NEVER branches on `kind`.
// It renders whatever FACETS a self-describing `BoardItem` carries:
//   * a `<rect>` always (geometry is universal),
//   * an `<image>` iff `src` is present,
//   * a wrapped `<text>` iff `text` is present,
//   * a routed `<path>` iff the item is a connector (via the live layer's `connectorPath`).
// A brand-new item kind that carries text+src+rect exports for free — ZERO edit
// here. The one piece of resolved fidelity (which fill a visual-layer-stack
// resolves to) is an INJECTED `fillOf(item)` resolver (same DI pattern as `mint`
// in `duplicateBoard`), so the pure fn stays pure and the owner supplies fidelity.
//
// SSOT — reads the board model's `BoardItem` (the single geometry source). The
// CALLER flattens the board tree (root + nested sections, world-space coords)
// into the `items` array; this fn is flat + pure.
// =============================================================================

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { finiteCoord } from './finite-coord.ts';
import { connectorLabelOf, type RelationKindSpec } from './relation-kind-catalog.ts';
import { presentationFrameOf } from './board-frames.ts';
import { arrowheadById, type ArrowheadShape } from './arrowhead-catalog.ts';
import { readFrameBorder } from './frame-border.ts';
import { svgItemTransform, svgCropImageRect, svgImageFilter } from './board-svg-transforms.ts';
import {
  connectorPath,
  readConnectorAnchor,
  readWaypoints,
  type ConnectorRect,
} from './connector-geometry.ts';
import { strokePathD, hashSeed, resolveStroke, arrowheadPoints, type Point } from './stroke-style.ts';

/** The default export font stack (the old hardcoded literal, now a fallback DATA value). */
const DEFAULT_EXPORT_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Owner-resolved presentation for one item's rectangle. Every field is an
 *  absent-→-default no-op (the appearance-data-family contract). */
export interface BoardSvgStyle {
  /** Solid fill (CSS color). Absent → neutral surface. */
  readonly fill?: string;
  /** Border color. Absent → neutral hairline. */
  readonly stroke?: string;
  /** Border width in px. Absent → 1. */
  readonly strokeWidth?: number;
  /** Corner radius in px. Absent → 0. */
  readonly cornerRadius?: number;
  /** 0..1 opacity for the whole item group. Absent → 1. */
  readonly opacity?: number;
  /** Text color. Absent → #1a1a1a. */
  readonly textColor?: string;
}

export interface BoardSvgOptions {
  /** Owner-supplied best-effort fill/border/opacity per item (e.g. resolved from
   *  `extra.visualLayerStack`). Injected so the core stays pure + testable. */
  readonly fillOf?: (item: BoardItem) => BoardSvgStyle | undefined;
  /** Owner-supplied resolver: a shape id (`extra.shape`, #213) → its bbox-FILLING
   *  SVG path `d` in a 0..100 percent viewBox (or `''` for none/rectangle). Injected
   *  (same DI as `fillOf`) so the serializer stays blind to the shape catalog (L090).
   *  When it returns a path, the item renders as that shape instead of a `<rect>` —
   *  the SAME path the live surface uses, so a shaped item and its export cannot
   *  diverge (the #213 live==export fix). */
  readonly shapePathById?: (shapeId: string) => string;
  /** cont.26 — Owner-supplied resolver: a shape id + the item's px size → its OUTLINE as an ordered
   *  closed point ring in the item's LOCAL box (0..w, 0..h), or undefined for none. Injected (same DI
   *  as `shapePathById`) so the serializer stays blind to the shape catalog (L090). Used ONLY when a
   *  shaped note carries a non-solid border brushstroke: the export then fills the shape and traces
   *  this outline via `resolveStroke`+`strokePathD` (pencil/marker/sketch bow, dashed/dotted dash) — the
   *  SAME leaves the live shaped-note branch uses, closing the shaped-note live==export gap. */
  readonly shapeOutlineById?: (shapeId: string, w: number, h: number) => readonly Point[] | undefined;
  /** Page padding around the content bounding box (px). Default 48. */
  readonly padding?: number;
  /** Page background fill behind everything (CSS color). Absent → transparent. */
  readonly background?: string;
  /** Base font size for note text (px). Default 15. */
  readonly fontSize?: number;
  /** Note-text font family (CSS stack) — dissolves the old hardcoded export font into DATA so a
   *  handwritten/sketch board EXPORTS in its font (Codex L090 fix). Absent → the system default. */
  readonly fontFamily?: string;
  /** cont.26 — hand-drawn roughness (px) BLANKET fallback for BOTH connectors and note/shape borders.
   *  0/absent → crisp (byte-identical export). >0 → pencil strokes via `strokePathD`. The board's TWO
   *  independent live axes below take precedence per-facet, so a sketch board exports as a sketch
   *  (what-you-see-is-what-you-export). */
  readonly roughness?: number;
  /** cont.26 — the board-default CONNECTOR roughness (px), mirroring the live `ConnectorLayer`'s
   *  `defaultRoughness`. Overrides `roughness` for connectors only; per-connector `extra.roughness`
   *  still wins. So the exported edges match the on-screen edges exactly (independent of note borders). */
  readonly connectorRoughness?: number;
  /** cont.26 Line-style axis — the board-default NAMED brushstroke id (`connectorStrokeStyle`),
   *  mirroring the live `ConnectorLayer`'s `defaultStrokeStyle`. Resolved (via `resolveStroke`) to
   *  roughness+bowing+dash per connector so a pencil/marker/sketch board EXPORTS in that brushstroke;
   *  per-connector `extra.strokeStyle` still wins. Absent/`solid` → crisp (byte-identical). */
  readonly connectorStrokeStyle?: string;
  /** cont.26 — the board-default NOTE/SHAPE BORDER roughness (px), mirroring the live `NoteItem`
   *  cascade default. Overrides `roughness` for item borders only; per-item `extra.borderRoughness`
   *  still wins. Kept distinct from `connectorRoughness` so export never over-roughens one axis. */
  readonly borderRoughness?: number;
  /** cont.26 Line-style axis — the board-default NAMED note-BORDER brushstroke id (`borderStrokeStyle`),
   *  mirroring the live `NoteItem` cascade. Resolved (via `resolveStroke`) to roughness+bowing+dash per
   *  item so a dashed/dotted/pencil/marker/sketch note border EXPORTS in that brushstroke; per-item
   *  `extra.borderStrokeStyle` still wins. Absent/`solid` → the crisp `<rect>` border (byte-identical). */
  readonly borderStrokeStyle?: string;
  /** An OPAQUE overlay rendered ABOVE all items (e.g. drawing ink owned by the
   *  addressed-marks package, serialized by ITS public surface). `svg` is a raw
   *  SVG fragment in the SAME world coordinates as items; `bounds` (world-space)
   *  expands the export viewBox so ink outside the item box is not clipped. The
   *  board stays BLIND to what the overlay contains (L090) — it only composes it. */
  readonly overlay?: BoardSvgOverlay;
  /** The relationship-kind catalog (same DATA the live layer uses), so a typed connector's midpoint
   *  label matches on screen and in the export (a `depends-on` line exports labelled "depends on",
   *  not bare — ML085 live == export). Absent → the built-in kinds. */
  readonly relationCatalog?: Readonly<Record<string, RelationKindSpec>>;
}

/** The opaque overlay contract for {@link boardToSvg}. A producer (e.g. the addressed-marks
 *  ink serializer) hands the board a finished SVG fragment + its world bounds; the board
 *  composites it verbatim above items and frames the viewBox to include `bounds`. */
export interface BoardSvgOverlay {
  readonly svg: string;
  readonly bounds?: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

const DEFAULT_STYLE: Required<Omit<BoardSvgStyle, never>> = {
  fill: '#fffdf5',
  stroke: '#e6e2d3',
  strokeWidth: 1,
  cornerRadius: 8,
  opacity: 1,
  textColor: '#1a1a1a',
};

const EMPTY_VIEWBOX = { minX: 0, minY: 0, width: 800, height: 600 } as const;

/** Cap on any single text/label string the serializer will process. A persisted note/label can carry
 *  an arbitrarily long string (valid JSON); `text.split('\n')` on a 10M-char value allocates the whole
 *  line array before the visible-line cap can stop it, and a giant label emits a multi-MB `<text>` — a
 *  DoS on export. Only a few hundred chars are ever visible in a note box, so this never truncates
 *  legible content; it only defuses a pathological/hostile string. */
const MAX_SVG_TEXT = 20000;

/** XML-escape a text node or attribute value. The ONE escaping site (SSOT). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** First strictly-positive finite number in the cascade, else 0. The roughness cascade primitive:
 *  per-item DATA wins, then the board-default axis, then the blanket fallback (L090 — the handler
 *  reads a self-describing value list, never branches on which source it came from). */
function firstPositive(...values: readonly (number | undefined)[]): number {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return 0;
}

/** Greedy width-based line wrap for SVG `<text>` (which does not auto-wrap).
 *  Approximate char width = fontSize * charWidth (proportional-font heuristic, 0.55 by default; a face
 *  narrower or wider than that names its own ratio as `extra.charWidth`).
 *  Height-clamped so text never overflows the rect. */
function wrapLines(rawText: string, w: number, h: number, fontSize: number, lineHeight = fontSize * 1.3, inset = 8, charWidth = 0.55): string[] {
  const text = rawText.length > MAX_SVG_TEXT ? rawText.slice(0, MAX_SVG_TEXT) : rawText; // DoS cap before split
  const innerW = Math.max(0, w - inset * 2);
  const charsPerLine = Math.max(1, Math.floor(innerW / (fontSize * charWidth)));
  const maxLines = Math.max(1, Math.floor((h - inset - 4) / lineHeight));
  // Wrap EVERY line first (capped at maxLines+1 so pathological text can't blow up work),
  // THEN clamp. Truncation — and therefore the ellipsis — must fire only when there is MORE
  // content than fits, never when the text fills exactly `maxLines`. The old code ellipsized
  // whenever `out.length >= maxLines`, so a note that fit perfectly lost its last line to a
  // spurious "…" (text "a\nb" with room for 2 lines rendered ["a","…"], dropping "b").
  const all: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (all.length > maxLines) break; // already know it overflows — stop wrapping early
    let remaining = rawLine.trimEnd();
    if (remaining === '') {
      all.push('');
      continue;
    }
    while (remaining.length > 0) {
      if (all.length > maxLines) break;
      if (remaining.length <= charsPerLine) {
        all.push(remaining);
        break;
      }
      // Prefer breaking at the last space within the window.
      let cut = remaining.lastIndexOf(' ', charsPerLine);
      if (cut <= 0) cut = charsPerLine;
      all.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
  }
  if (all.length <= maxLines) return all; // fits exactly (or less) → NO ellipsis
  // Genuinely truncated: keep the first maxLines and ellipsize the last.
  const out = all.slice(0, maxLines);
  const last = out[maxLines - 1] ?? '';
  out[maxLines - 1] = last.length > 1 ? `${last.slice(0, Math.max(0, last.length - 1))}…` : '…';
  return out;
}

/**
 * Serialize a FLAT list of board items (root + recursed sections, world-space)
 * into a standalone SVG document string.
 */
export function boardToSvg(itemsRaw: readonly BoardItem[], opts: BoardSvgOptions = {}): string {
  const padding = num(opts.padding, 48);
  const fontSize = num(opts.fontSize, 15);
  const fillOf = opts.fillOf;
  // Clamp every item's geometry through the finiteCoord SSOT at the ONE entry: a persisted
  // Number.MAX_VALUE coordinate (valid JSON) would otherwise overflow `it.x + it.w` to Infinity and
  // emit an invalid viewBox / rect / path that breaks or hangs rasterization. A no-op for real coords.
  const items: readonly BoardItem[] = itemsRaw.map((i) => ({
    ...i,
    x: finiteCoord(i.x),
    y: finiteCoord(i.y),
    w: finiteCoord(i.w),
    h: finiteCoord(i.h),
  }));

  const connectors = items.filter(itemIsConnector);
  const drawables = items.filter((it) => !itemIsConnector(it));

  // memberId -> item, for connector endpoint lookup (built across ALL drawables).
  const byMember = new Map<string, BoardItem>();
  for (const it of drawables) byMember.set(it.memberId, it);

  // Bounding box of drawable content + any overlay bounds (so ink/overlay outside
  // the item box is not clipped from the export). Computed across both so an
  // ink-only board (no items) still frames the ink.
  let box = EMPTY_VIEWBOX as { minX: number; minY: number; width: number; height: number };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of drawables) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  const ob = opts.overlay?.bounds;
  if (ob) {
    minX = Math.min(minX, ob.minX);
    minY = Math.min(minY, ob.minY);
    maxX = Math.max(maxX, ob.maxX);
    maxY = Math.max(maxY, ob.maxY);
  }
  if (minX !== Infinity) {
    box = { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  const vbX = box.minX - padding;
  const vbY = box.minY - padding;
  const vbW = box.width + padding * 2;
  const vbH = box.height + padding * 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" ` +
      `width="${Math.round(vbW)}" height="${Math.round(vbH)}" ` +
      `font-family="${escapeXml(opts.fontFamily ?? DEFAULT_EXPORT_FONT)}">`,
  );
  if (typeof opts.background === 'string' && opts.background.length > 0) {
    parts.push(`<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${escapeXml(opts.background)}"/>`);
  }

  // Connectors render BENEATH items (drawn first). #224 — the export now consumes the SAME
  // `connectorPath` the live ConnectorLayer uses (one geometry SSOT → live == export), so a
  // curved/elbow/waypointed, arrowed, dashed, labelled edge exports as itself instead of a
  // naive center-to-center `<line>`. Reads the connector's self-describing `extra.*` DATA
  // (routing/anchors/waypoints/arrow/dashed/color/thickness/label). `routing` flows as an
  // opaque string to the OPEN ROUTING_ALGORITHMS dispatcher (unknown → straight), so a
  // newly-registered routing exports for free — never narrowed to a closed list here.
  const connectorColor = (c: BoardItem): string =>
    (typeof c.extra?.color === 'string' && c.extra.color) || fillOf?.(c)?.stroke || '#6b7280';
  // Resolve the RENDERABLE connectors first (both endpoints present) — a dangling connector
  // contributes nothing (no marker, no path). Honest degradation, and no orphan <defs>.
  const renderable: Array<{ c: BoardItem; from: BoardItem; to: BoardItem }> = [];
  for (const c of connectors) {
    const fromId = typeof c.extra?.fromMemberId === 'string' ? (c.extra.fromMemberId as string) : undefined;
    const toId = typeof c.extra?.toMemberId === 'string' ? (c.extra.toMemberId as string) : undefined;
    const from = fromId ? byMember.get(fromId) : undefined;
    const to = toId ? byMember.get(toId) : undefined;
    if (from && to) renderable.push({ c, from, to });
  }
  // b94 — one arrow `<marker>` per DISTINCT (colour, SHAPE) pair, painted with that exact colour (NOT
  // `context-stroke`) so a downloaded `.svg` shows correctly-coloured arrowheads in ANY renderer. Shape
  // geometry comes from the SAME `CONNECTOR_ARROWHEADS` catalog the live layer renders (one SSOT → the
  // on-screen head and the exported one are identical). Per-item `extra.arrowHead` selects the shape; the
  // `none` shape is a headless line (no marker).
  const headOf = (c: BoardItem): ArrowheadShape => arrowheadById(typeof c.extra?.arrowHead === 'string' ? c.extra.arrowHead : undefined);
  const markerKey = (c: BoardItem): string => `${connectorColor(c)}|${headOf(c).id}`;
  const markerIdByKey = new Map<string, string>();
  for (const { c } of renderable) {
    if (!headOf(c).path) continue; // `none` → no marker
    const key = markerKey(c);
    if (!markerIdByKey.has(key)) markerIdByKey.set(key, `board-conn-arrow-${markerIdByKey.size}`);
  }
  if (markerIdByKey.size > 0) {
    const defs: string[] = ['<defs>'];
    for (const [key, id] of markerIdByKey) {
      const col = key.slice(0, key.lastIndexOf('|'));
      const shape = arrowheadById(key.slice(key.lastIndexOf('|') + 1));
      const fill = shape.filled ? escapeXml(col) : 'none';
      const stroke = shape.stroked ? ` stroke="${escapeXml(col)}" stroke-width="1.5"` : '';
      defs.push(
        `<marker id="${id}" viewBox="0 0 10 10" refX="${shape.refX}" refY="5" markerWidth="7" markerHeight="7" ` +
          `orient="auto-start-reverse"><path d="${shape.path}" fill="${fill}"${stroke}/></marker>`,
      );
    }
    defs.push('</defs>');
    parts.push(defs.join(''));
  }
  const labelFontSize = num(opts.fontSize, 15) * 0.8;
  for (const { c, from, to } of renderable) {
    const aRect: ConnectorRect = { x: from.x, y: from.y, w: from.w, h: from.h };
    const bRect: ConnectorRect = { x: to.x, y: to.y, w: to.w, h: to.h };
    const routing = typeof c.extra?.routing === 'string' && c.extra.routing.length > 0 ? c.extra.routing : 'straight';
    // 'avoid' routing dodges the other node boxes — pass them so the export matches the live render
    // (one geometry SSOT). Every other mode ignores obstacles; only avoid-lines pay the gather.
    const obstacles =
      routing === 'avoid'
        ? drawables.filter((n) => n.memberId !== from.memberId && n.memberId !== to.memberId).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
        : undefined;
    const { d, p1, p2, mid } = connectorPath(
      routing,
      aRect,
      bRect,
      readConnectorAnchor(c.extra?.fromAnchor),
      readConnectorAnchor(c.extra?.toAnchor),
      readWaypoints(c.extra?.waypoints),
      undefined,
      obstacles,
    );
    const col = connectorColor(c);
    const markerId = markerIdByKey.get(markerKey(c)); // undefined for the `none` head shape
    // Line weight (#197): the connector's self-describing thickness DATA (default 2px).
    const tw = typeof c.extra?.thickness === 'number' && c.extra.thickness > 0 ? c.extra.thickness : 2;
    // cont.26 Line-style axis — resolve the connector's NAMED brushstroke (per-line `extra.strokeStyle`
    // or the board `connectorStrokeStyle`) plus any raw roughness/bowing/dashed override into
    // {roughness, bowing, dash} through the SAME `resolveStroke` SSOT the live `ConnectorLayer` uses
    // (one resolver → live == export). A raw roughness (per-line, `connectorRoughness`, or the blanket
    // `roughness`) still overrides the style's roughness; dash comes from a dashed/dotted style OR a
    // per-line `dashed`. 0 roughness → the crisp routed `d` (byte-identical for an un-themed edge).
    const stroke = resolveStroke(
      typeof c.extra?.strokeStyle === 'string' ? c.extra.strokeStyle : opts.connectorStrokeStyle,
      firstPositive(typeof c.extra?.roughness === 'number' ? c.extra.roughness : undefined, opts.connectorRoughness, opts.roughness),
      typeof c.extra?.bowing === 'number' ? c.extra.bowing : undefined,
      c.extra?.dashed === true ? true : undefined,
    );
    const dash = stroke.dash ? ` stroke-dasharray="${stroke.dash}"` : '';
    // Arrow (#101): 'both'|'none' from DATA, else the default 'end' (matches the live layer).
    const arrow = c.extra?.arrow === 'both' || c.extra?.arrow === 'none' ? c.extra.arrow : 'end';
    const markerEnd = arrow === 'none' || !markerId ? '' : ` marker-end="url(#${markerId})"`;
    const markerStart = arrow === 'both' && markerId ? ` marker-start="url(#${markerId})"` : '';
    if (stroke.roughness > 0) {
      const chain: Point[] = [p1, ...readWaypoints(c.extra?.waypoints), p2];
      const roughPaths = strokePathD(chain, { roughness: stroke.roughness, bowing: stroke.bowing, doubleStroke: true }, hashSeed(c.memberId));
      roughPaths.forEach((rd, i, arr) => {
        const op = i === 0 && arr.length > 1 ? ' opacity="0.75"' : '';
        parts.push(
          `<path d="${rd}" fill="none" stroke="${escapeXml(col)}" stroke-width="${tw}" ` +
            `stroke-linecap="round" stroke-linejoin="round"${dash}${op}/>`,
        );
      });
      // cont.26 — a hand-drawn connector EXPORTS a hand-drawn ARROWHEAD too (the crisp `<marker>` is
      // only for crisp lines): an open V traced by the SAME `arrowheadPoints`+`strokePathD` leaves the
      // live layer uses (live == export). End head along the last segment; the 'both' start head along
      // the first. So a pencil/sketch arrow exports hand-drawn end-to-end, not a sharp triangle.
      const headSize = Math.max(9, tw * 3.2);
      const emitHead = (tip: Point, from: Point, seed: string) => {
        const h = arrowheadPoints(tip, from, headSize);
        if (!h.length) return;
        for (const hd of strokePathD(h, { roughness: stroke.roughness, bowing: stroke.bowing }, hashSeed(seed))) {
          parts.push(`<path d="${hd}" fill="none" stroke="${escapeXml(col)}" stroke-width="${tw}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
      };
      if (arrow !== 'none') emitHead(p2, chain[chain.length - 2], `${c.memberId}:end`);
      if (arrow === 'both') emitHead(p1, chain[1], `${c.memberId}:start`);
    } else {
      parts.push(
        `<path d="${d}" fill="none" stroke="${escapeXml(col)}" stroke-width="${tw}" ` +
          `stroke-linecap="round" stroke-linejoin="round"${dash}${markerEnd}${markerStart}/>`,
      );
    }
    // Label chip at the path midpoint (#100) — a small rounded pill + centered text, the
    // exported twin of the live midpoint chip. Absent/blank label → nothing.
    // Resolve the midpoint label through the SAME `connectorLabelOf` SSOT the live layer uses, so a
    // typed relationship (extra.relationKind, no explicit label) exports its catalog label instead
    // of a bare line (live == export, ML085). Explicit extra.label still wins; blank → no chip.
    const resolvedLabel = connectorLabelOf(c.extra, opts.relationCatalog);
    const labelFull = typeof resolvedLabel === 'string' && resolvedLabel.trim() !== '' ? resolvedLabel.trim() : '';
    const label = labelFull.length > MAX_SVG_TEXT ? labelFull.slice(0, MAX_SVG_TEXT) : labelFull; // DoS cap
    if (label) {
      // Chip width mirrors the live midpoint chip (~3.6px/char + 8 at the live font), scaled
      // to the export font so a labelled connector's pill matches on screen and in the export.
      const chipW = Math.max(16, label.length * labelFontSize * 0.3 + 8);
      const chipH = labelFontSize + 8;
      parts.push(
        `<rect x="${mid.x - chipW / 2}" y="${mid.y - chipH / 2}" width="${chipW}" height="${chipH}" ` +
          `rx="4" ry="4" fill="#ffffff" stroke="${escapeXml(col)}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${mid.x}" y="${mid.y + labelFontSize * 0.35}" font-size="${labelFontSize}" ` +
          `text-anchor="middle" fill="#1a1a1a">${escapeXml(label)}</text>`,
      );
    }
  }

  for (const it of drawables) {
    const style = { ...DEFAULT_STYLE, ...(fillOf?.(it) ?? {}) };
    const opacityAttr = style.opacity !== 1 ? ` opacity="${style.opacity}"` : '';
    // FACET: node transform (#222). Rotation + flip ride self-describing DATA
    // (`extra.rotation`/`extra.flipX`/`extra.flipY`); the transform wraps the WHOLE item
    // group (rect + image + text) about its center — the SAME order the live CanvasNode
    // uses, so a rotated/flipped item's export matches the canvas. Absent → '' (identity),
    // so every unrotated/unflipped item exports byte-identically to before.
    const itemTransform = svgItemTransform(it);
    const transformAttr = itemTransform ? ` transform="${itemTransform}"` : '';
    parts.push(`<g${opacityAttr}${transformAttr}>`);
    // FACET: geometry. A self-describing `extra.shape` (#213) renders as a bbox-FILLING
    // path — the SAME path the live surface uses (one SSOT → live == export). The path
    // is authored in a 0..100 percent box, placed by translate+scale to the item's rect;
    // `vector-effect="non-scaling-stroke"` keeps the border crisp under non-uniform scale.
    // Absent shape → the universal rectangle (unchanged).
    const shapeId = typeof it.extra?.shape === 'string' ? (it.extra.shape as string) : undefined;
    const shapePath = shapeId && opts.shapePathById ? opts.shapePathById(shapeId) : '';
    // cont.26 Line-style BORDER — resolve the note-border NAMED brushstroke (per-item `extra.borderStrokeStyle`
    // or the board `borderStrokeStyle`) + any raw `borderRoughness` through the SAME `resolveStroke` the
    // live NoteItem uses (live == export). Shared by BOTH the shaped-note and rect-note branches below.
    const borderStroke = resolveStroke(
      typeof it.extra?.borderStrokeStyle === 'string' ? it.extra.borderStrokeStyle : opts.borderStrokeStyle,
      firstPositive(typeof it.extra?.borderRoughness === 'number' ? it.extra.borderRoughness : undefined, opts.borderRoughness, opts.roughness),
    );
    const borderDash = borderStroke.dash ? ` stroke-dasharray="${borderStroke.dash}"` : '';
    const borderActive = borderStroke.roughness > 0 || Boolean(borderStroke.dash);
    if (shapePath) {
      // A shaped note with a NON-SOLID border brushstroke: fill the shape, then trace its OUTLINE (the
      // owner-injected `shapeOutlineById`, kept blind to the catalog) via `strokePathD` — pencil/marker/
      // sketch bow, dashed/dotted dash — the SAME leaves the live shaped-note branch uses (closes the
      // shaped-note live==export gap). Solid/absent-outline → the crisp `<path>`, byte-identical.
      const outline = borderActive && shapeId && opts.shapeOutlineById ? opts.shapeOutlineById(shapeId, it.w, it.h) : undefined;
      if (outline && outline.length > 1) {
        parts.push(
          `<path d="${shapePath}" transform="translate(${it.x} ${it.y}) scale(${it.w / 100} ${it.h / 100})" ` +
            `fill="${escapeXml(style.fill)}" stroke="none"/>`,
        );
        const worldPts: Point[] = outline.map((p) => ({ x: it.x + p.x, y: it.y + p.y }));
        for (const rd of strokePathD(worldPts, { roughness: borderStroke.roughness, bowing: borderStroke.bowing, doubleStroke: true }, hashSeed(it.memberId))) {
          parts.push(`<path d="${rd}" fill="none" stroke="${escapeXml(style.stroke)}" stroke-width="${Math.max(1.4, style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${borderDash}/>`);
        }
      } else {
        parts.push(
          `<path d="${shapePath}" transform="translate(${it.x} ${it.y}) scale(${it.w / 100} ${it.h / 100})" ` +
            `fill="${escapeXml(style.fill)}" stroke="${escapeXml(style.stroke)}" stroke-width="${style.strokeWidth}" ` +
            `vector-effect="non-scaling-stroke"/>`,
        );
      }
    } else {
      // cont.26 Line-style BORDER (rect note) — the resolved brushstroke draws the border: pencil/marker/
      // sketch bow, dashed/dotted draw a crisp dashed outline. Fill the rect, then trace its corners with
      // `strokePathD` (one crisp path at roughness 0, two bowed above). A solid style → the crisp `<rect>`
      // border, byte-identical.
      if (borderActive) {
        const m = 2;
        const corners: Point[] = [
          { x: it.x + m, y: it.y + m }, { x: it.x + it.w - m, y: it.y + m },
          { x: it.x + it.w - m, y: it.y + it.h - m }, { x: it.x + m, y: it.y + it.h - m }, { x: it.x + m, y: it.y + m },
        ];
        parts.push(`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="${style.cornerRadius}" ry="${style.cornerRadius}" fill="${escapeXml(style.fill)}"/>`);
        for (const rd of strokePathD(corners, { roughness: borderStroke.roughness, bowing: borderStroke.bowing, doubleStroke: true }, hashSeed(it.memberId))) {
          parts.push(`<path d="${rd}" fill="none" stroke="${escapeXml(style.stroke)}" stroke-width="${Math.max(1.4, style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${borderDash}/>`);
        }
      } else {
        parts.push(
          `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" ` +
            `rx="${style.cornerRadius}" ry="${style.cornerRadius}" ` +
            `fill="${escapeXml(style.fill)}" stroke="${escapeXml(style.stroke)}" stroke-width="${style.strokeWidth}"/>`,
        );
      }
    }

    // FACET: media image (clipped to the rect via a per-item clipPath). The clip STAYS
    // the item rect; a crop (#222, `extra.crop`) instead ENLARGES + offsets the image so
    // only the crop window shows through that clip — the SVG equivalent of the live
    // `cropImageStyle`. A color filter (#222, `extra.imageFilter`) is the same validated
    // CSS filter string the live surface uses (browsers apply it when rasterizing SVG).
    if (typeof it.src === 'string' && it.src.length > 0) {
      const clipId = `clip-${escapeXml(it.memberId)}`;
      parts.push(
        `<clipPath id="${clipId}"><rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" ` +
          `rx="${style.cornerRadius}" ry="${style.cornerRadius}"/></clipPath>`,
      );
      const img = svgCropImageRect(it.extra?.crop, it.x, it.y, it.w, it.h);
      const filter = svgImageFilter(it);
      const filterAttr = filter ? ` style="filter:${escapeXml(filter)}"` : '';
      // `extra.imageFit: 'contain'` shows the whole image inside the rect (a logo); absent → it fills the rect.
      const fit = it.extra?.imageFit === 'contain' ? 'meet' : 'slice';
      parts.push(
        `<image href="${escapeXml(it.src)}" x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" ` +
          `preserveAspectRatio="xMidYMid ${fit}" clip-path="url(#${clipId})"${filterAttr}/>`,
      );
    }

    // FACET: text (sections carry their title here too). An item may carry its OWN type the same way it
    // carries its own font: `extra.fontSize` (px), `extra.fontWeight`, `extra.lineHeight` (a multiple of
    // the size), `extra.textInset` (px from the rect's edge) and `extra.charWidth` (the face's average
    // character width as a multiple of the size, for wrapping). Each absent → the board default, so an
    // item without them exports byte-identical.
    if (typeof it.text === 'string' && it.text.trim().length > 0) {
      const itemSize = num(it.extra?.fontSize, fontSize);
      const lineHeight = itemSize * num(it.extra?.lineHeight, 1.3);
      const inset = num(it.extra?.textInset, 8);
      const lines = wrapLines(it.text, it.w, it.h, itemSize, lineHeight, inset, num(it.extra?.charWidth, 0.55));
      const startY = it.y + inset + itemSize;
      const tspans = lines
        .map((line, i) => `<tspan x="${it.x + inset}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
        .join('');
      // A note can carry its OWN font (`extra.fontFamily`, e.g. the sketch/infra-stack template's
      // handwritten boxes). The live render honors it per item (item override > board > global); the
      // export must too, else a Comic-Sans box exports in the board font. Emit `font-family` on the
      // item's `<text>` ONLY when it has its own — an override of the group-level board font-family
      // (set once above); items without it inherit that group font, so the SVG is byte-identical.
      const itemFont = typeof it.extra?.fontFamily === 'string' && it.extra.fontFamily ? it.extra.fontFamily : undefined;
      const fontAttr = itemFont ? ` font-family="${escapeXml(itemFont)}"` : '';
      const weight = it.extra?.fontWeight;
      const weightAttr = typeof weight === 'number' || (typeof weight === 'string' && /^(normal|bold|[1-9]00)$/.test(weight)) ? ` font-weight="${weight}"` : '';
      parts.push(`<text font-size="${itemSize}"${fontAttr}${weightAttr} fill="${escapeXml(style.textColor)}">${tspans}</text>`);
    }

    parts.push('</g>');
  }

  // OPAQUE overlay (e.g. drawing ink) on TOP of every item — composed verbatim, the
  // board never parses it (L090). Same world coordinates as items → no transform.
  if (typeof opts.overlay?.svg === 'string' && opts.overlay.svg.length > 0) {
    parts.push(opts.overlay.svg);
  }

  parts.push('</svg>');
  return parts.join('');
}

/** Best-effort per-item fill/border/opacity for SVG export, read from the item's
 *  `extra.visualLayerStack.frame` DATA (the same frame the canvas renders). This
 *  is the honest v1 resolver — the full layer→CSS resolution (gradients, image
 *  fills, multi-layer compositing) is the #143 follow-on. Media items get a
 *  transparent fill so the `<image>` shows through with no paper behind it. This
 *  is the DEFAULT `fillOf` the board passes to `boardToSvg`; extracted here (beside
 *  BoardSvgStyle) so the export contract owns its own resolver, not the surface. */
export function exportFillOf(item: BoardItem): BoardSvgStyle | undefined {
  const stack = item.extra?.visualLayerStack as { frame?: Record<string, unknown> } | undefined;
  const frame = stack?.frame;
  const style: { fill?: string; stroke?: string; strokeWidth?: number; cornerRadius?: number; opacity?: number } = {};
  if (frame) {
    if (typeof frame.opacity === 'number') style.opacity = frame.opacity;
    if (typeof frame.cornerRadius === 'number') style.cornerRadius = frame.cornerRadius;
    // ONE canonical border reader (SSOT with the live card render) — was a private
    // `{color,width}` parse that disagreed with the live boolean schema (#198).
    const border = readFrameBorder(frame.border);
    if (border.color) style.stroke = border.color;
    if (border.width) style.strokeWidth = border.width;
  }
  if (typeof item.src === 'string' && item.src.length > 0) style.fill = 'none';
  // #169 — a presentation frame exports as a TRANSPARENT OUTLINE (never the opaque
  // default paper box), matching its on-canvas chrome so a story-path export frames
  // the content instead of hiding it. Shape-predicate (L090) — the SAME discipline the
  // serializer uses for `itemIsConnector`, never a `kind === 'frame'` literal. An
  // explicit user border on the frame still overrides the default outline.
  if (presentationFrameOf(item) !== null) {
    style.fill = 'none';
    if (style.stroke === undefined) {
      style.stroke = '#94a3b8';
      style.strokeWidth = style.strokeWidth ?? 2;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
