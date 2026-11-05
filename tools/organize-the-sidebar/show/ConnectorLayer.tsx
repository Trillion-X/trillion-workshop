// packages/group/show/ConnectorLayer.tsx
//
// The EDGE layer of the board canvas — relationship lines between items
// (Milanote/Mural/FigJam/ClickUp canon). A connector is a board MEMBER carrying
// two endpoint refs (`fromMemberId`/`toMemberId`) in its presentation; this layer
// resolves each ref to its live rect and draws a line + arrowhead between the two
// boxes. It is the dual of the NODE layer: a node is a 0-D placed box, an edge is
// a 1-D relation between two boxes — the one Physics distinction in any graph
// canvas, not a Society kind branch. ONE generic render path serves every
// connector; a new edge style is DATA on the member, never new code here.
//
// Lives INSIDE the world transform, so it pans/zooms with the items in pure world
// coordinates. Raw SVG is the irreducible primitive for canvas geometry (same
// justified exception as the addressed-marks ink layer) — there is no `ui`
// component for a vector edge.

import React from 'react';

import {
  connectorPath,
  type ConnectorAnchor,
  type ConnectorRect,
  type Pt,
} from '../do-work/connector-geometry.ts';
import { strokePathD, hashSeed, resolveStroke, arrowheadPoints } from './stroke-style.ts';
import { pointsAlongPath, pointsFromLinePath, verticalSegments, pathWithJumps, type Seg } from '../do-work/connector-jumps.ts';
import { fanLaneMultipliers, bowedChord, FAN_SPACING } from '../do-work/connector-fan.ts';
import { selfLoopIndices, selfLoopPath } from '../do-work/connector-self-loop.ts';
import { roundedPolyline } from '../do-work/connector-corners.ts';
import { CONNECTOR_ARROWHEADS, arrowheadById } from '../do-work/arrowhead-catalog.ts';

// ConnectorRect + the geometry now live in the pure `do-work/connector-geometry`
// module (unit-tested, no DOM). Re-exported here so existing importers of the
// rect type keep working.
export type { ConnectorRect } from '../do-work/connector-geometry.ts';

/** One connector to draw: its id + the two member ids it relates + selection. */
export interface ConnectorModel {
  memberId: string;
  fromMemberId: string;
  toMemberId: string;
  selected: boolean;
  /** Relationship name carried as DATA on the member; rendered as a chip at the
   *  line midpoint when set. */
  label?: string;
  /** Line + arrow color (hex). Absent → the default accent/idle color. */
  color?: string;
  /** Dashed line when true; solid otherwise. */
  dashed?: boolean;
  /** Line weight in px (#197). Absent → the default 2px. A selected line renders +0.5px
   *  thicker for emphasis regardless of this value. */
  thickness?: number;
  /** A NAMED brushstroke id (cont.26 Line-style axis) — `solid`/`dashed`/`dotted`/`pencil`/`marker`/
   *  `sketch`/… from `STROKE_STYLES`. Resolves (via `resolveStroke`) to roughness+bowing+dash TOGETHER,
   *  so a new brushstroke is one catalog row, not a render branch (L090). Absent → the board default. */
  strokeStyle?: string;
  /** Hand-drawn roughness in px (cont.26) — a RAW per-line override of the chosen style's roughness.
   *  Absent → the style's roughness (0 = crisp, byte-identical). Positive → a pencil/sketch stroke via
   *  `strokePathD` (the wobble is stable per `memberId`). DATA on the member, never a render branch. */
  roughness?: number;
  /** RAW per-line override of the chosen style's bowing (how far segment midpoints arc). Absent →
   *  the style's bowing. 0 = straight-but-jittered. Flows into `strokePathD` so marker≠pencil≠sketch. */
  bowing?: number;
  /** Arrowhead placement: 'end' (default, at the `to` item), 'both', or 'none'. */
  arrow?: 'end' | 'both' | 'none';
  /** Arrowhead SHAPE (b94) — the NAME of a shape in `CONNECTOR_ARROWHEADS` ('triangle' default / 'open' /
   *  'diamond' / 'circle' / 'bar' / 'none'). DATA on the member, resolved to a `<marker>` by the blind
   *  renderer — a new head shape is one catalog row, never a render branch (L090). Absent → the board
   *  default → 'triangle'. 'none' suppresses the head regardless of `arrow`. */
  arrowHead?: string;
  /** Path geometry: the NAME of a routing algorithm in `ROUTING_ALGORITHMS` — the
   *  shipped set is 'straight' (default) / 'curved' / 'elbow' / 'waypoints', but the
   *  type is `string` because the algorithm map is OPEN (a composition root can register
   *  more); `connectorPath` resolves any name and falls back to straight for unknown.
   *  DATA on the member, not a render branch. */
  routing?: string;
  /** Manual bend points (#194) — absolute world points the line passes through when
   *  `routing:'waypoints'`. Absent/empty → a plain single segment. */
  waypoints?: readonly Pt[];
  /** Fixed-port pin for the `from` endpoint — a normalized point {nx,ny} in the
   *  item box (#2). Absent → the endpoint auto-routes to the nearest border. */
  fromAnchor?: ConnectorAnchor;
  /** Fixed-port pin for the `to` endpoint. Absent → auto-route. */
  toAnchor?: ConnectorAnchor;
  /** Faded when true — the connector is outside the active relationship focus (dim, still
   *  selectable). Absent/false → full opacity (byte-identical to before). The layer owns the
   *  fade constant so callers only say WHICH lines are out of focus, not how faint. */
  dimmed?: boolean;
}

/** The live creation preview: a dashed line from the source toward the cursor. */
export interface ConnectorPreview {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface ConnectorLayerProps {
  connectors: readonly ConnectorModel[];
  /** memberId → live rect, for resolving each endpoint to the box border. */
  rects: ReadonlyMap<string, ConnectorRect>;
  /** Active drag preview (Connector tool / endpoint re-anchor), or null. */
  preview: ConnectorPreview | null;
  /** Select a connector (click its line). `additive` = shift-click. */
  onSelect: (memberId: string, additive: boolean) => void;
  /** Begin dragging one endpoint of a SELECTED connector to rewire it. When absent,
   *  endpoint handles are not rendered (edit-disabled / unit-test mode). */
  onEndpointDown?: (memberId: string, which: 'from' | 'to', clientX: number, clientY: number) => void;
  /** Double-click a connector to name the relationship (opens the board text input). */
  onLabelEdit?: (memberId: string) => void;
  /** Begin dragging a bend point of a SELECTED waypointed connector (#194). When
   *  absent, waypoint handles are not rendered (edit-disabled / unit-test mode). */
  onWaypointDown?: (memberId: string, index: number, clientX: number, clientY: number) => void;
  /** Double-click a bend handle to delete that bend (#194). */
  onWaypointRemove?: (memberId: string, index: number) => void;
  /** R2b — the board's DEFAULT idle connector colour + width (from the appearance cascade). The
   *  idle line uses these when a connector has no per-line `extra.color`/`thickness` and isn't
   *  selected. Absent → the built-in IDLE / 2 (so callers that don't theme connectors, e.g. the
   *  capsule opener, stay byte-identical). Per-connector overrides and the selected ACCENT still win. */
  idleColor?: string;
  defaultWidth?: number;
  /** R2b (cont.) — the board's DEFAULT connector STYLE (from the appearance cascade): the idle
   *  arrow direction / routing / dashed used when a connector has no per-line `extra.arrow`/
   *  `routing`/`dashed`. Absent → the built-in `end` / `straight` / solid (zero-regression for
   *  callers that don't theme connectors). Per-connector overrides still win. */
  defaultArrow?: 'end' | 'both' | 'none';
  defaultRouting?: string;
  defaultDashed?: boolean;
  /** cont.26 — the board's DEFAULT connector roughness (from the appearance cascade). Idle lines
   *  use it when a connector has no per-line `extra.roughness`. Absent/0 → crisp (zero-regression). */
  defaultRoughness?: number;
  /** cont.26 (Line-style axis) — the board's DEFAULT NAMED brushstroke id (`connectorStrokeStyle`
   *  from the appearance cascade). Idle lines use it when a connector has no per-line `strokeStyle`;
   *  it supplies roughness+bowing+dash together. Absent → `solid` (crisp, zero-regression). A raw
   *  `defaultRoughness`/per-line `roughness`/`dashed` still overrides the resolved axis. */
  defaultStrokeStyle?: string;
  /** Board-level LINE JUMPS (draw.io/yEd canon): when true, a connector's crisp orthogonal path hops
   *  over the connectors it crosses with a small arc, so crossing wires read apart from a junction.
   *  Absent/false → straight crossings (zero-regression). Horizontal-hops-over-vertical, so exactly one
   *  line arcs per crossing. Curved/hand-drawn lines are unaffected (no plain polyline to hop). */
  jumps?: boolean;
  /** Board-level ROUNDED CORNERS (draw.io/Lucidchart canon): when true, an orthogonal connector (elbow /
   *  avoid) turns each 90° corner into a smooth quadratic fillet instead of a hard corner. Absent/false →
   *  sharp corners (zero-regression). Straight/curved/fanned/self-loop lines have no orthogonal corner to
   *  round, so they are unaffected. */
  roundedCorners?: boolean;
  /** Board-level DEFAULT arrowhead SHAPE (b94, from the appearance cascade) — the head shape a connector
   *  uses when it has no per-line `arrowHead`. Absent → 'triangle' (byte-identical). Per-line still wins. */
  defaultArrowHead?: string;
}

const ACCENT = 'var(--accent-primary, #6366f1)';
const JUMP_RADIUS = 6;
const CORNER_RADIUS = 12;
const IDLE = 'var(--border-strong, rgba(100, 116, 139, 0.85))';

/**
 * Render every connector as a routed path + arrowhead from one item's border to
 * the other's (straight / curved / elbow per the member's `routing` DATA), plus
 * the in-flight creation preview. Dangling connectors (an endpoint was deleted)
 * are skipped — a missing rect renders nothing, so referential gaps never throw.
 */
export function ConnectorLayer({ connectors, rects, preview, onSelect, onEndpointDown, onLabelEdit, onWaypointDown, onWaypointRemove, idleColor, defaultWidth, defaultArrow, defaultRouting, defaultDashed, defaultRoughness, defaultStrokeStyle, jumps, roundedCorners, defaultArrowHead }: ConnectorLayerProps) {
  // Geometry for one connector (endpoints resolved, 'avoid' fed the other node boxes). Null when an
  // endpoint rect is missing (dangling). SSOT for both the render map and the line-jump pre-pass.
  // Parallel multi-edge fan: connectors that share the SAME endpoint pair resolve to the SAME path and
  // stack invisibly; the fan leaf hands each a signed lane so its wire bows apart. A lone edge on its pair
  // (and any self-loop) is ABSENT → lane 0 → its routing is untouched (byte-identical, so always-on is safe).
  const fanLanes = React.useMemo(
    () => fanLaneMultipliers(connectors.map((c) => ({ id: c.memberId, from: c.fromMemberId, to: c.toMemberId }))),
    [connectors],
  );
  // Self-loops: a connector whose two ends are the SAME node can't route (both endpoints collapse to the
  // box centre → a zero-length line); it renders as a loop instead. This memo numbers a node's self-loops
  // so multiples nest as concentric loops. A normal edge is absent → never looks up here.
  const selfLoops = React.useMemo(
    () => selfLoopIndices(connectors.map((c) => ({ id: c.memberId, from: c.fromMemberId, to: c.toMemberId }))),
    [connectors],
  );
  const pathDataFor = React.useCallback(
    (c: ConnectorModel) => {
      const a = rects.get(c.fromMemberId);
      const b = rects.get(c.toMemberId);
      if (!a || !b) return null;
      // Same-node edge → a loop off the box (index nests multiples), before any straight/routing logic.
      if (c.fromMemberId === c.toMemberId) return selfLoopPath(a, selfLoops.get(c.memberId) ?? 0);
      const routing = c.routing ?? defaultRouting ?? 'straight';
      let obstacles: ConnectorRect[] | undefined;
      if (routing === 'avoid') {
        obstacles = [];
        for (const [id, r] of rects) if (id !== c.fromMemberId && id !== c.toMemberId) obstacles.push(r);
      }
      const geo = connectorPath(routing, a, b, c.fromAnchor, c.toAnchor, c.waypoints, undefined, obstacles);
      // Bow this edge onto its lane when it's part of a coincident bundle (else lane 0 → geo unchanged).
      const lane = fanLanes.get(c.memberId) ?? 0;
      if (lane !== 0) {
        const bow = bowedChord(geo.p1, geo.p2, lane * FAN_SPACING);
        return { ...geo, d: bow.d, mid: bow.mid };
      }
      // Rounded corners: soften an orthogonal polyline's 90° turns (elbow/avoid). A non-polyline path
      // (straight/curved) yields < 3 points → returned unchanged, so this only touches cornered routes.
      if (roundedCorners) {
        const pts = pointsFromLinePath(geo.d);
        if (pts.length >= 3) return { ...geo, d: roundedPolyline(pts, CORNER_RADIUS) };
      }
      return geo;
    },
    [rects, defaultRouting, fanLanes, selfLoops, roundedCorners],
  );
  // Line jumps (opt-in): each connector's VERTICAL segments, keyed by id, so a connector can hop over
  // EVERY OTHER connector's verticals (excluding its own). Computed only when `jumps` is on (else null →
  // zero extra work, byte-identical render). Curved/hand-drawn paths yield no polyline → contribute none.
  const crossersById = React.useMemo(() => {
    if (!jumps) return null;
    const m = new Map<string, Seg[]>();
    for (const c of connectors) {
      const geo = pathDataFor(c);
      if (!geo) continue;
      const pts = pointsFromLinePath(geo.d);
      if (pts.length >= 2) m.set(c.memberId, verticalSegments(pts));
    }
    return m;
  }, [jumps, connectors, pathDataFor]);
  return (
    <svg
      aria-hidden
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      <defs>
        {/* b94 — one `<marker>` per arrowhead SHAPE in the DATA catalog (triangle/open/diamond/circle/bar).
            `context-stroke` paints each head with its own line's colour, so ONE marker per shape serves every
            colour. The blind renderer emits whatever the catalog row describes — a new shape is one DATA row,
            zero render code (L090). The `none` sentinel (empty path) gets no marker. */}
        {CONNECTOR_ARROWHEADS.filter((s) => s.path).map((s) => (
          <marker
            key={s.id}
            id={`board-arrowhead-${s.id}`}
            viewBox="0 0 10 10"
            refX={s.refX}
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d={s.path}
              fill={s.filled ? 'context-stroke' : 'none'}
              stroke={s.stroked ? 'context-stroke' : 'none'}
              strokeWidth={s.stroked ? 1.5 : undefined}
            />
          </marker>
        ))}
      </defs>
      {connectors.map((c) => {
        // Geometry (endpoints + routing, 'avoid' dodges the other boxes) via the shared pathDataFor SSOT.
        const geo = pathDataFor(c);
        if (!geo) return null; // dangling endpoint — skip (also pruned on delete)
        const { p1, p2, mid } = geo;
        // Line jumps (opt-in): hop this crisp path over every OTHER connector's vertical segments so
        // crossing wires read apart. Only when a plain polyline (curved paths yield none → unchanged `d`).
        let d = geo.d;
        if (crossersById) {
          const pts = pointsFromLinePath(d);
          if (pts.length >= 2) {
            const crossers: Seg[] = [];
            for (const [id, segs] of crossersById) if (id !== c.memberId) crossers.push(...segs);
            d = pathWithJumps(pts, crossers, JUMP_RADIUS);
          }
        }
        // Style from the member's self-describing DATA; the board-DEFAULT (from the appearance
        // cascade) fills in when a line has no per-line value; the built-in constants are the final
        // fallback so an unthemed board stays byte-identical (accent when selected, idle otherwise).
        const color = c.color || (c.selected ? ACCENT : (idleColor || IDLE));
        const arrow = c.arrow ?? defaultArrow ?? 'end';
        // b94 — the arrowhead SHAPE (per-line → board default → triangle), resolved to its `<marker>` id.
        // The `none` shape yields no marker (a headless line) regardless of the `arrow` direction.
        const headShape = arrowheadById(c.arrowHead ?? defaultArrowHead);
        const headMarker = headShape.path ? `url(#board-arrowhead-${headShape.id})` : undefined;
        // cont.26 Line-style axis — ONE resolver turns the NAMED brushstroke (per-line or board default)
        // plus any raw per-line/board override into {roughness, bowing, dash} together. `dashed`
        // collapses into the style ('dashed'/'dotted') while a raw per-line `dashed`/board `defaultDashed`
        // still forces a dash — SSOT precedence lives in `resolveStroke`, not scattered here.
        const stroke = resolveStroke(
          c.strokeStyle ?? defaultStrokeStyle,
          c.roughness ?? defaultRoughness,
          c.bowing,
          (c.dashed ?? defaultDashed) === true ? true : undefined,
        );
        const dash = stroke.dash;
        // Line weight (#197): the member's thickness DATA (default 2px), +0.5 when
        // selected for the same emphasis the old hardcoded 2→2.5 gave. The hit-band
        // grows with the line so a thick line stays as easy to click as a thin one.
        const baseWidth = c.thickness && c.thickness > 0 ? c.thickness : (defaultWidth && defaultWidth > 0 ? defaultWidth : 2);
        const strokeW = c.selected ? baseWidth + 0.5 : baseWidth;
        const hitWidth = Math.max(14, baseWidth + 12);
        // cont.26 — hand-drawn stroke: the resolved brushstroke's roughness+bowing render the visible
        // line via `strokePathD` (a stable pencil wobble seeded by memberId). 0 → crisp (the original
        // single `d` path, byte-identical). The invisible hit-band stays crisp `d` so selection is
        // unchanged regardless of style. Threading `bowing` is what makes marker≠pencil≠sketch visible.
        // The rough stroke traces the ROUTED path (the same geometry as the hit band: elbow, avoid, fan,
        // self-loop, curves, bends), not a straight chain through the stored bends, so the line a person
        // sees is the line they click.
        const routed = pointsAlongPath(geo.d);
        const chain = routed.length >= 2 ? routed : [p1, ...(c.waypoints ?? []), p2];
        const roughPaths = stroke.roughness > 0
          ? strokePathD(chain, { roughness: stroke.roughness, bowing: stroke.bowing, doubleStroke: true }, hashSeed(c.memberId))
          : null;
        // cont.26 — a hand-drawn connector gets a hand-drawn ARROWHEAD too (the crisp `<marker>` triangle
        // is only for crisp lines): an open V traced by `strokePathD`, seeded per-end so it wobbles like
        // the line. End head points along the last segment; the 'both' start head along the first. So a
        // pencil/sketch arrow is hand-drawn end-to-end (Excalidraw discipline), not a sharp triangle.
        const headSize = Math.max(9, strokeW * 3.2);
        const roughHeads: string[] = [];
        if (roughPaths) {
          if (arrow !== 'none') {
            const h = arrowheadPoints(p2, chain[chain.length - 2], headSize);
            if (h.length) roughHeads.push(...strokePathD(h, { roughness: stroke.roughness, bowing: stroke.bowing }, hashSeed(`${c.memberId}:end`)));
          }
          if (arrow === 'both') {
            const h = arrowheadPoints(p1, chain[1], headSize);
            if (h.length) roughHeads.push(...strokePathD(h, { roughness: stroke.roughness, bowing: stroke.bowing }, hashSeed(`${c.memberId}:start`)));
          }
        }
        return (
          // Dimmed lines fade to 0.2 (out of the active relationship focus) but stay clickable —
          // group opacity is visual only, the transparent hit-band still receives pointer events.
          <g key={c.memberId} data-connector={c.memberId} opacity={c.dimmed ? 0.2 : 1}>
            {/* Fat transparent hit-band so a thin path is easy to click-select. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={hitWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(c.memberId, e.shiftKey);
              }}
              onDoubleClick={onLabelEdit ? (e) => { e.stopPropagation(); onLabelEdit(c.memberId); } : undefined}
            />
            {(roughPaths ?? [d]).map((pd, i, arr) => (
              <path
                key={i}
                d={pd}
                fill="none"
                stroke={color}
                strokeWidth={strokeW}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={dash}
                opacity={roughPaths && i === 0 ? 0.75 : 1}
                markerStart={!roughPaths && i === arr.length - 1 && arrow === 'both' ? headMarker : undefined}
                markerEnd={!roughPaths && i === arr.length - 1 && arrow !== 'none' ? headMarker : undefined}
                style={{ pointerEvents: 'none' }}
              />
            ))}
            {/* Hand-drawn arrowhead V-strokes (rough connectors only — crisp lines keep the marker). */}
            {roughHeads.map((hd, i) => (
              <path key={`h${i}`} d={hd} fill="none" stroke={color} strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
            ))}
            {/* A SELECTED connector shows a round handle at each endpoint — drag one
                onto a different item to rewire that end (FigJam/Miro/Mural canon). */}
            {c.selected && onEndpointDown
              ? ([
                  { which: 'from' as const, p: p1 },
                  { which: 'to' as const, p: p2 },
                ]).map(({ which, p }) => (
                  <circle
                    key={which}
                    cx={p.x}
                    cy={p.y}
                    r={6}
                    fill="var(--surface-1, #fff)"
                    stroke={ACCENT}
                    strokeWidth={2}
                    style={{ pointerEvents: 'all', cursor: 'grab' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      // Capture so endpoint moves keep arriving after the cursor leaves
                      // the small handle; they bubble to the stage's pointer-move/up.
                      (e.currentTarget as unknown as Element).setPointerCapture?.(e.pointerId);
                      onEndpointDown(c.memberId, which, e.clientX, e.clientY);
                    }}
                  />
                ))
              : null}
            {/* A SELECTED waypointed connector shows a small square handle at each
                bend — drag to reshape the route, double-click to delete the bend
                (draw.io/Lucidchart canon). Squares distinguish bends from the round
                endpoint handles above. */}
            {c.selected && onWaypointDown && c.waypoints
              ? c.waypoints.map((w, i) => (
                  <rect
                    key={`wp-${i}`}
                    x={w.x - 5}
                    y={w.y - 5}
                    width={10}
                    height={10}
                    rx={2}
                    fill="var(--surface-1, #fff)"
                    stroke={ACCENT}
                    strokeWidth={2}
                    style={{ pointerEvents: 'all', cursor: 'grab' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget as unknown as Element).setPointerCapture?.(e.pointerId);
                      onWaypointDown(c.memberId, i, e.clientX, e.clientY);
                    }}
                    onDoubleClick={
                      onWaypointRemove
                        ? (e) => {
                            e.stopPropagation();
                            onWaypointRemove(c.memberId, i);
                          }
                        : undefined
                    }
                  />
                ))
              : null}
            {c.label ? ((mx, my, halfW) => (
              <g style={{ pointerEvents: 'none' }}>
                <rect
                  x={mx - halfW}
                  y={my - 11}
                  width={halfW * 2}
                  height={22}
                  rx={6}
                  fill="var(--surface-1, #fff)"
                  stroke={color}
                  strokeWidth={1}
                />
                <text
                  x={mx}
                  y={my}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fill="var(--text-primary, #1f2937)"
                >
                  {c.label}
                </text>
              </g>
            ))(mid.x, mid.y, Math.max(14, c.label.length * 3.6 + 8))
              : null}
          </g>
        );
      })}
      {preview ? (
        <line
          x1={preview.from.x}
          y1={preview.from.y}
          x2={preview.to.x}
          y2={preview.to.y}
          stroke={ACCENT}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="6 5"
          markerEnd="url(#board-arrowhead-triangle)"
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
    </svg>
  );
}
