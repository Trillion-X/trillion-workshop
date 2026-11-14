// packages/ui/show/anchor-resolver/anchor-resolver.ts
//
// PURPOSE
// The anchor resolver (engine mechanism M2) for the guided-overlay walkthrough.
// A step's `target_ref` is an OPAQUE self-describing reference; this module turns
// it into a live on-screen rect and computes where a coachmark card should sit
// relative to it — preferring a side, auto-flipping when it doesn't fit, and
// falling back to the corner covering the least of the target when nothing fits. If the target element is
// absent, resolution returns a FAILURE STATE (never throws) so the tour can show
// a "can't find it" affordance instead of crashing (G9).
//
// TWO FIRST-PRINCIPLES PIECES
//   1. BLIND ref-resolver registry (L090): `target_ref.from` is an open string
//      (`node-ref` | `selector` | anything future). A registry maps `from` → a
//      resolver function; dispatch is a lookup, never `if (from === 'node-ref')`.
//      A new ref kind = one `register()` + zero change here.
//   2. PURE placement geometry: the 4 cardinal sides of a rect ARE closed by
//      Physics (2D space), so `Side` is a legitimate closed set (not a Society
//      enum). `placement.prefer` is OPEN DATA mapped to a side, defaulting safely.

import { NODE_REF_ATTR, serializeNodeRef, type NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
import { createBlindRegistry } from '../blind-registry/blind-registry';

// ─────────────────────────────────────────────────────────────────────────────
// Geometry types
// ─────────────────────────────────────────────────────────────────────────────

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The 4 cardinal placements — closed by Physics (2D), not a Society enum. */
export type Side = 'above' | 'below' | 'left' | 'right';

const OPPOSITE: Record<Side, Side> = { above: 'below', below: 'above', left: 'right', right: 'left' };
const PERPENDICULAR: Record<Side, readonly [Side, Side]> = {
  above: ['left', 'right'],
  below: ['left', 'right'],
  left: ['above', 'below'],
  right: ['above', 'below'],
};

export interface PlacementInput {
  /** Open DATA hint mapped to a Side; unknown/absent → `below`. */
  readonly prefer?: string;
  /** Try the opposite + perpendicular sides when the preferred one doesn't fit. */
  readonly auto_flip?: boolean;
  /** Gap between target and card, in px (DATA, default 8). */
  readonly gap?: number;
}

export interface PlacementResult {
  readonly x: number;
  readonly y: number;
  readonly side: Side;
  /** True when the chosen side differs from the preferred one. */
  readonly flipped: boolean;
  /** True when no side fit cleanly: the card sits where it covers the least of the target, with no pointer. */
  readonly overlapsTarget: boolean;
}

function normalizeSide(prefer: string | undefined): Side {
  return prefer === 'above' || prefer === 'below' || prefer === 'left' || prefer === 'right' ? prefer : 'below';
}

function placeOnSide(target: Rect, card: Size, side: Side, gap: number): { x: number; y: number } {
  const cx = target.x + target.width / 2 - card.width / 2;
  const cy = target.y + target.height / 2 - card.height / 2;
  switch (side) {
    case 'below':
      return { x: cx, y: target.y + target.height + gap };
    case 'above':
      return { x: cx, y: target.y - card.height - gap };
    case 'right':
      return { x: target.x + target.width + gap, y: cy };
    case 'left':
      return { x: target.x - card.width - gap, y: cy };
  }
}

function fits(pos: { x: number; y: number }, card: Size, viewport: Size): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x + card.width <= viewport.width && pos.y + card.height <= viewport.height;
}

function clamp(pos: { x: number; y: number }, card: Size, viewport: Size): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(pos.x, viewport.width - card.width)),
    y: Math.max(0, Math.min(pos.y, viewport.height - card.height)),
  };
}

function shiftAlongSide(pos: { x: number; y: number }, card: Size, viewport: Size, side: Side): { x: number; y: number } {
  const clamped = clamp(pos, card, viewport);
  return side === 'above' || side === 'below' ? { x: clamped.x, y: pos.y } : { x: pos.x, y: clamped.y };
}

/**
 * Compute where the coachmark card sits relative to the target. Tries the
 * preferred side; if `auto_flip`, then the opposite, then the two perpendicular
 * sides, each allowed to slide along the target's edge to stay on screen. If none fit (a target as big as the screen, a
 * phone with no room beside it), the card goes to the corner of the screen where it covers the least of the target. PURE — no DOM.
 */
export function computePlacement(
  target: Rect,
  card: Size,
  viewport: Size,
  placement: PlacementInput = {},
): PlacementResult {
  const prefer = normalizeSide(placement.prefer);
  const gap = placement.gap ?? 8;
  const order: Side[] = placement.auto_flip === false
    ? [prefer]
    : [prefer, OPPOSITE[prefer], ...PERPENDICULAR[prefer]];

  for (const side of order) {
    // A card may slide along the target's edge to stay on screen (a target at the
    // screen's edge still gets its card above or below it), never across it.
    const pos = shiftAlongSide(placeOnSide(target, card, side, gap), card, viewport, side);
    if (fits(pos, card, viewport)) {
      return { ...pos, side, flipped: side !== prefer, overlapsTarget: false };
    }
  }
  // Nothing fit cleanly: each side clamped on screen, plus the four corners; the one covering the least of the target wins.
  const overlap = (pos: { x: number; y: number }) =>
    Math.max(0, Math.min(pos.x + card.width, target.x + target.width) - Math.max(pos.x, target.x))
    * Math.max(0, Math.min(pos.y + card.height, target.y + target.height) - Math.max(pos.y, target.y));
  const right = Math.max(0, viewport.width - card.width);
  const bottom = Math.max(0, viewport.height - card.height);
  const candidates: { x: number; y: number; side: Side }[] = [
    ...order.map((side) => ({ ...clamp(placeOnSide(target, card, side, gap), card, viewport), side })),
    { x: 0, y: 0, side: 'above' }, { x: right, y: 0, side: 'above' },
    { x: 0, y: bottom, side: 'below' }, { x: right, y: bottom, side: 'below' },
  ];
  const best = candidates.reduce((a, b) => (overlap(b) < overlap(a) ? b : a));
  return { x: best.x, y: best.y, side: best.side, flipped: best.side !== prefer, overlapsTarget: true };
}

/**
 * Where a card sits after the person moved it by (dx, dy): its placed spot plus the move, kept wholly inside the frame
 * so it can never be dragged out of reach. PURE.
 */
export function moveCardWithin(
  placed: { x: number; y: number },
  move: { x: number; y: number },
  card: Size,
  frame: Size,
): { x: number; y: number } {
  const within = (value: number, room: number) => Math.min(Math.max(0, value), Math.max(0, room));
  return {
    x: within(placed.x + move.x, frame.width - card.width),
    y: within(placed.y + move.y, frame.height - card.height),
  };
}

/**
 * Where to draw the coachmark's tail: on the card edge that faces the target, aligned with the target centre and inset
 * from the corners (card placed `below` the target → tail on the card's top edge, pointing up). A card that had to sit
 * over its target (`result.overlapsTarget`) has no tail. PURE.
 */
export interface CoachmarkPointer { readonly kind: 'tail'; readonly side: Side; readonly x: number; readonly y: number }

export function coachmarkPointer(
  result: PlacementResult,
  target: Rect,
  card: Size,
  inset = 12,
): CoachmarkPointer | null {
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;
  if (result.overlapsTarget) return null;
  const tailEdge = OPPOSITE[result.side];
  const clampX = (v: number) => Math.max(result.x + inset, Math.min(v, result.x + card.width - inset));
  const clampY = (v: number) => Math.max(result.y + inset, Math.min(v, result.y + card.height - inset));
  switch (tailEdge) {
    case 'above':
      return { kind: 'tail', side: tailEdge, x: clampX(tcx), y: result.y };
    case 'below':
      return { kind: 'tail', side: tailEdge, x: clampX(tcx), y: result.y + card.height };
    case 'left':
      return { kind: 'tail', side: tailEdge, x: result.x, y: clampY(tcy) };
    case 'right':
      return { kind: 'tail', side: tailEdge, x: result.x + card.width, y: clampY(tcy) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blind ref-resolver registry
// ─────────────────────────────────────────────────────────────────────────────

/** An opaque, self-describing reference to a screen element. `from` is open DATA. */
export interface AnchorRef {
  readonly from: string;
  readonly family?: string;
  readonly parts?: Readonly<Record<string, string>>;
  /** Some ref kinds (`selector`) carry a raw query instead of family/parts. */
  readonly query?: string;
}

/** Resolves a ref of one `from` kind to a live element (or null if absent). */
export type AnchorRefResolver = (ref: AnchorRef, root: ParentNode) => Element | null;

export interface AnchorResolverRegistry {
  register(from: string, resolver: AnchorRefResolver): void;
  /** Resolve a ref to an element via the registered resolver for its `from`; null if none/absent. */
  resolveElement(ref: AnchorRef, root?: ParentNode): Element | null;
  has(from: string): boolean;
}

/**
 * The element a query names that the person can see: the same control can be drawn twice (a screen open beside a
 * locked page and again in the hidden arrangement under it), and a step must point at the one on screen. With no
 * shown match it is the first match, as before; a root without querySelectorAll is asked for its first match.
 */
function shownMatch(root: ParentNode, selector: string): Element | null {
  if (typeof (root as { querySelectorAll?: unknown }).querySelectorAll !== 'function') return root.querySelector(selector);
  const all = root.querySelectorAll(selector);
  for (const element of all) {
    if (typeof (element as { getClientRects?: unknown }).getClientRects === 'function' && element.getClientRects().length > 0) return element;
  }
  return all[0] ?? null;
}

/** The built-in `node-ref` resolver: find `[data-node-ref="<serialized>"]`. */
export const nodeRefAnchorResolver: AnchorRefResolver = (ref, root) => {
  if (typeof ref.family !== 'string') return null;
  const nodeRef: NodeRef = { family: ref.family, parts: ref.parts ?? {} };
  const selector = `[${NODE_REF_ATTR}="${cssEscape(serializeNodeRef(nodeRef))}"]`;
  return shownMatch(root, selector);
};

/** The built-in `selector` resolver: a raw CSS query (DATA-supplied). */
export const selectorAnchorResolver: AnchorRefResolver = (ref, root) =>
  typeof ref.query === 'string' && ref.query ? shownMatch(root, ref.query) : null;

/**
 * Create a registry pre-seeded with the built-in `node-ref` + `selector`
 * resolvers. Delegates to the shared `blind-registry` primitive (L069); the
 * anchor registry adds only the `resolveElement` invoke wrapper (look up the
 * resolver for `ref.from`, then call it with the ref + root).
 */
export function createAnchorResolverRegistry(): AnchorResolverRegistry {
  const reg = createBlindRegistry<AnchorRefResolver>();
  reg.register('node-ref', nodeRefAnchorResolver);
  reg.register('selector', selectorAnchorResolver);
  return {
    register: (from, resolver) => reg.register(from, resolver),
    resolveElement(ref, root = typeof document !== 'undefined' ? document : (null as unknown as ParentNode)) {
      const resolver = reg.get(ref?.from);
      if (!resolver || !root) return null; // unknown kind or no DOM → unresolved (blind, no throw)
      return resolver(ref, root);
    },
    has: (from) => reg.has(from),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (ref → rect, failure-as-state)
// ─────────────────────────────────────────────────────────────────────────────

export type AnchorResolution =
  | { readonly status: 'resolved'; readonly rect: Rect; readonly element: Element }
  | { readonly status: 'unresolved'; readonly reason: 'no-resolver' | 'not-found' };

/** Resolve a ref to a live rect, or a failure state (G9 — never throws). */
export function resolveAnchorRect(
  registry: AnchorResolverRegistry,
  ref: AnchorRef,
  root?: ParentNode,
): AnchorResolution {
  if (!registry.has(ref?.from)) return { status: 'unresolved', reason: 'no-resolver' };
  const el = registry.resolveElement(ref, root);
  if (!el) return { status: 'unresolved', reason: 'not-found' };
  const r = el.getBoundingClientRect();
  return { status: 'resolved', element: el, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

/**
 * Minimal CSS attribute-value escape (quotes/backslashes) for building
 * `[attr="value"]` selectors from arbitrary string data. Deliberately not the
 * global `CSS.escape` — that escapes for BARE identifiers (e.g. `#foo.bar`)
 * and is unavailable in some DOM test environments; this only needs to keep
 * a quoted attribute value syntactically valid, which is a much smaller and
 * more portable contract. Exported so any caller building an attribute
 * selector from data-supplied ids reuses this instead of re-deriving it.
 */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
