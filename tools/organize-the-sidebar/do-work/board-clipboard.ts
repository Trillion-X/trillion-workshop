// packages/group/do-work/board-clipboard.ts
//
// The portable item-bundle primitive: copy a SET of board items into an opaque,
// position-normalized clipboard record, then paste them onto ANY board at a new
// origin with their relative layout preserved. This is the whole-item sibling of
// the VisualLayerStackRecord portable-bundle primitive (#88/#92) — copy/paste,
// duplicate, and cross-board move are all configurations of it (L069).
//
// GENERIC: speaks only the BoardItem shape + plain place-drafts. It has no notion
// of "vision board" vs any other group surface, does no I/O, and holds no React
// state — the live store below is a module singleton so a copy survives switching
// boards or even separate surface instances within the session.
//
// CORRECTNESS NOTE (the latent placeItem bug this fixes): placeItem spreads the
// caller's `extra` AFTER x/y/w/h, so any geometry left in `extra` clobbers the new
// position. We therefore strip x/y/w/h out of the carried `extra` — the paste
// origin is authoritative for position; `extra` carries only the non-geometric
// presentation (html, locked, visualLayerStack, border, …).

import type { BoardItem } from '../read-data/group-board-model.ts';
import type { CapsuleBoard } from '../read-data/share-capsule.ts';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack/visual-layer-types';
import { finiteCoord } from '../read-data/finite-coord.ts';

/** The most items a single paste/import will materialize. A crafted clipboard/capsule payload can carry
 *  an arbitrary count; without a budget, clipboardToDrafts + planPaste allocate + mint unboundedly and
 *  freeze the commit path. A real copy is at most a board's worth; 20k is far beyond any real selection. */
const MAX_PASTE_ITEMS = 20000;

/** `Math.min` over an array WITHOUT spreading it into the call — `Math.min(...arr)` throws
 *  `RangeError: Maximum call stack size exceeded` once the array exceeds the JS argument limit, so
 *  copying/importing a huge board (hundreds of thousands of items) crashed here. A reduce is O(n)-safe. */
function minOf(values: Iterable<number>): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

/** One item captured for the clipboard, with its offset from the bundle anchor. */
export interface PortableBoardItem {
  kind: string;
  w: number;
  h: number;
  text?: string;
  src?: string;
  /** Non-geometric presentation (html, locked, visualLayerStack, border, …). For a
   *  connector, the endpoint member ids are STRIPPED out (they live in from/toLocalId). */
  extra?: Record<string, unknown>;
  /** Offset from the bundle's top-left anchor (so multi-item layout is preserved). */
  dx: number;
  dy: number;
  /** Stable id of this item WITHIN the bundle (its original member id). Lets a paste
   *  remap connector endpoints from bundle-local ids to the freshly minted member ids. */
  localId: string;
  /** For a connector: the bundle-local ids of its two endpoints (both guaranteed to be
   *  present in the bundle — a connector to an item outside the copied set is dropped). */
  fromLocalId?: string;
  toLocalId?: string;
}

/** An opaque, position-normalized bundle of items. Self-describing + serializable. */
export interface BoardItemClipboard {
  kind: 'board-item-clipboard';
  version: 1;
  items: PortableBoardItem[];
}

// Geometry keys (owned by the paste origin) + connector endpoint keys (owned by the
// bundle-local from/toLocalId, remapped on paste) are stripped from the carried `extra`.
const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h']);
const ENDPOINT_KEYS = new Set(['fromMemberId', 'toMemberId']);
// Keys that must never be copied out of an UNTRUSTED capsule's `extra`: assigning
// `out['__proto__'] = v` (bracket assignment) triggers the prototype SETTER, not a data
// property — a prototype-pollution vector. `constructor`/`prototype` are guarded for the same
// reason. A share capsule is attacker-controlled, so the copy path drops them (fail-closed).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A finite number or the fallback — a hostile capsule can carry NaN/Infinity coordinates. */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Strip geometry keys (see CORRECTNESS NOTE) and, when the item is a connector, the raw
 * endpoint member ids — those are stale the moment the item is cloned, so they travel as
 * bundle-local ids (from/toLocalId) and are re-resolved on paste instead of leaking here.
 */
function carriedExtra(
  extra: Record<string, unknown> | undefined,
  isConnector: boolean,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (GEOMETRY_KEYS.has(k)) continue;
    if (DANGEROUS_KEYS.has(k)) continue; // never bracket-assign __proto__/constructor/prototype
    if (isConnector && ENDPOINT_KEYS.has(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A connector's endpoint member ids if this item is a connector, else null (shape-based). */
function connectorEndpoints(item: BoardItem): { from: string; to: string } | null {
  const from = item.extra?.fromMemberId;
  const to = item.extra?.toMemberId;
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
}

/**
 * The bundle anchor (top-left) over the NON-connector items. Connectors are stored at (0,0)
 * — their geometry is DERIVED from their endpoints, not a real position — so letting them
 * into the min would drag the anchor to the origin and land the pasted/imported group far
 * from the drop point (invisible for a nearby copy, badly off-screen for a shared board whose
 * nodes sit at large world coords). Falls back to all items only if the set is
 * connectors-only (nothing else to anchor on). Shared by copy AND capsule-import so both
 * normalize identically (one owner — L030/L063).
 */
function boundingOrigin(
  pts: ReadonlyArray<{ x: number; y: number; isConnector: boolean }>,
): { minX: number; minY: number } {
  const anchors = pts.filter((p) => !p.isConnector);
  const base = anchors.length ? anchors : pts;
  // minOf (not Math.min(...spread)) so a huge board doesn't RangeError; finiteCoord so a persisted
  // Number.MAX_VALUE coordinate can't make the anchor ±Infinity (which would then collapse every dx/dy).
  return { minX: minOf(base.map((p) => finiteCoord(p.x))), minY: minOf(base.map((p) => finiteCoord(p.y))) };
}

/**
 * Capture the given items into a clipboard bundle, normalized so the top-left of the
 * group's bounding box is the (0,0) anchor. Each item carries its original member id as a
 * bundle-local id; a connector additionally carries its two endpoint local ids and is
 * INCLUDED only when BOTH endpoints are also in the copied set — a connector to an item
 * outside the selection would dangle, so it is dropped (matches #141's whole-board remap).
 * Returns null for an empty set.
 */
export function copyItemsToClipboard(items: ReadonlyArray<BoardItem>): BoardItemClipboard | null {
  if (items.length === 0) return null;
  const { minX, minY } = boundingOrigin(
    items.map((i) => ({ x: i.x, y: i.y, isConnector: connectorEndpoints(i) !== null })),
  );
  const ids = new Set(items.map((i) => i.memberId));
  const portable: PortableBoardItem[] = [];
  for (const i of items) {
    const endpoints = connectorEndpoints(i);
    // Drop a connector whose other end is not being copied — it cannot be re-anchored.
    if (endpoints && (!ids.has(endpoints.from) || !ids.has(endpoints.to))) continue;
    portable.push({
      kind: i.kind,
      w: i.w,
      h: i.h,
      text: i.text,
      src: i.src,
      extra: carriedExtra(i.extra as Record<string, unknown> | undefined, endpoints !== null),
      dx: finiteCoord(i.x) - minX, // clamp so a MAX_VALUE coord can't make dx ±Infinity (which collapses on paste)
      dy: finiteCoord(i.y) - minY,
      localId: i.memberId,
      ...(endpoints ? { fromLocalId: endpoints.from, toLocalId: endpoints.to } : {}),
    });
  }
  return { kind: 'board-item-clipboard', version: 1, items: portable };
}

/**
 * Convert one shared-capsule board into the clipboard bundle shape, so IMPORTING a shared
 * board rides the EXACT copy/paste clone pipeline ({@link clipboardToDrafts} → {@link planPaste}):
 * fresh member ids + internal connectors re-anchored, zero new remap logic (L030/L069 — the
 * capsule import is just another clipboard SOURCE). The capsule's `PortableItem` carries
 * absolute world coords + its original member id + (for a connector) endpoint ids inside
 * `extra.fromMemberId/toMemberId`; here we normalize to the bounding-box origin (dx/dy),
 * lift the endpoints out to bundle-local from/toLocalId, and strip geometry + endpoint keys
 * from `extra` via the SAME `carriedExtra` the copy path uses. A connector whose endpoint is
 * absent from the board is dropped (it would dangle) — identical rule to
 * {@link copyItemsToClipboard}. Pure; empty board → empty bundle.
 */
export function capsuleBoardToClipboard(board: CapsuleBoard): BoardItemClipboard {
  const items = board.items;
  if (items.length === 0) return { kind: 'board-item-clipboard', version: 1, items: [] };
  const endpointsOf = (i: (typeof items)[number]) => {
    const ex = i.extra as { fromMemberId?: unknown; toMemberId?: unknown } | undefined;
    const from = ex?.fromMemberId;
    const to = ex?.toMemberId;
    return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
  };
  const { minX, minY } = boundingOrigin(
    items.map((i) => ({ x: i.x, y: i.y, isConnector: endpointsOf(i) !== null })),
  );
  const ids = new Set(items.map((i) => i.memberId));
  const portable: PortableBoardItem[] = [];
  for (const i of items) {
    const endpoints = endpointsOf(i);
    const from = endpoints?.from;
    const to = endpoints?.to;
    const isConnector = endpoints !== null;
    // Drop a connector whose other end was not shared — it cannot be re-anchored.
    if (isConnector && (!ids.has(from as string) || !ids.has(to as string))) continue;
    portable.push({
      kind: i.kind,
      w: i.w,
      h: i.h,
      text: i.text,
      src: i.src,
      extra: carriedExtra(i.extra as Record<string, unknown> | undefined, isConnector),
      dx: finiteCoord(i.x) - minX, // clamp so a MAX_VALUE coord can't make dx ±Infinity (which collapses on paste)
      dy: finiteCoord(i.y) - minY,
      localId: i.memberId,
      ...(isConnector ? { fromLocalId: from as string, toLocalId: to as string } : {}),
    });
  }
  return { kind: 'board-item-clipboard', version: 1, items: portable };
}

/** A ready-to-place draft (the exact args placeItem takes, minus the fresh ids). */
export interface PasteDraft {
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  src?: string;
  extra?: Record<string, unknown>;
  /** Bundle-local id of this draft (carried from the clipboard so paste can remap). */
  localId?: string;
  /** Connector endpoints as bundle-local ids (remapped to fresh member ids by planPaste). */
  fromLocalId?: string;
  toLocalId?: string;
}

/**
 * Resolve a clipboard bundle into place-drafts anchored at (originX, originY).
 * Relative layout is preserved via each item's dx/dy. The bundle-local ids ride along so
 * {@link planPaste} can re-anchor connector endpoints; the caller assigns fresh member/node
 * ids (via planPaste) and calls placeItem for each planned placement.
 */
export function clipboardToDrafts(
  clipboard: BoardItemClipboard,
  originX: number,
  originY: number,
): PasteDraft[] {
  // Fail closed on a malformed payload (a crafted external clipboard could carry a non-array `items`,
  // which would throw on `.map`) and BUDGET the count (a million-item bundle would freeze the commit
  // path — a real copy is at most a board's worth). Trusted in-process copies are always well under.
  const items = Array.isArray(clipboard.items) ? clipboard.items.slice(0, MAX_PASTE_ITEMS) : [];
  return items.map((it) => ({
    kind: it.kind,
    // Fail closed on a hostile capsule's non-finite geometry: a NaN dx/originX would round to NaN
    // and place the item at a NaN coordinate (it vanishes / breaks layout); a NaN w/h would size it
    // NaN. Trusted (live-board) copies are always finite, so this is zero-regression for them.
    x: Math.round(finiteOr(originX, 0) + finiteOr(it.dx, 0)),
    y: Math.round(finiteOr(originY, 0) + finiteOr(it.dy, 0)),
    w: finiteOr(it.w, 1),
    h: finiteOr(it.h, 1),
    text: it.text,
    src: it.src,
    // STRUCTURAL boundary defense (L063/L098): this resolver is the ONE funnel EVERY paste flows
    // through, and it already declares itself fail-closed for a crafted external clipboard (the count
    // budget + finiteOr coords above). Route the untrusted extra through the SAME carriedExtra SSOT the
    // copy/capsule producers use, so the boundary owns its FULL validation instead of most of it: it
    // drops the proto-pollution keys (__proto__/constructor/prototype) and any geometry left in extra
    // (geometry there clobbers the paste-origin position via placeItem's extra-spread). Idempotent for
    // the trusted copy/capsule callers (their extra is already stripped, a no-op with zero regression);
    // it hardens any present or future raw-clipboard paste source so callers never depend on remembering
    // to sanitize. isConnector (endpoint keys dropped) is inferred from the bundle-local endpoint ids.
    extra: carriedExtra(it.extra, it.fromLocalId !== undefined && it.toLocalId !== undefined),
    localId: it.localId,
    fromLocalId: it.fromLocalId,
    toLocalId: it.toLocalId,
  }));
}

/** A draft with its freshly minted member id, ready for `placeItem` — connectors last, with
 *  endpoints re-anchored to the new node ids. */
export interface PlannedPlacement {
  memberId: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  src?: string;
  extra?: Record<string, unknown>;
  /** True for a connector draft — the caller keeps only NON-connector ids as the selection. */
  isConnector: boolean;
  /** The bundle-local id this placement was minted from (its original member id). Lets a
   *  caller correlate a source item to its fresh clone — e.g. the Alt-drag anchor. */
  localId?: string;
}

/**
 * Assign fresh member ids to paste-drafts and re-anchor internal connectors — THE clone
 * primitive that keeps a duplicated sub-diagram's arrows intact (fixes the silent
 * corruption where a pasted connector still pointed at the original member ids). Pure and
 * deterministic given `mintId`:
 *
 *  1. Nodes first — mint an id for each non-connector draft, recording `localId → newId`.
 *  2. Connectors next — mint an id and rewrite `extra.fromMemberId/toMemberId` to the NEW
 *     node ids via the map; a connector whose endpoint was not pasted is dropped (it would
 *     dangle). Connectors sort last so they render above the nodes they join.
 *
 * `mintId` is injected (no I/O here) so the whole remap is unit-testable with a counter.
 */
export function planPaste(drafts: readonly PasteDraft[], mintId: () => string): PlannedPlacement[] {
  const localToNew = new Map<string, string>();
  const nodes: PlannedPlacement[] = [];
  const connectorDrafts: PasteDraft[] = [];
  for (const d of drafts) {
    if (d.fromLocalId && d.toLocalId) {
      connectorDrafts.push(d);
      continue;
    }
    const memberId = mintId();
    // FIRST-WINS on a duplicate localId (a corrupted/crafted bundle can repeat a bundle-local id): both
    // nodes are still placed under their own fresh ids, but a connector to that id remaps DETERMINISTICALLY
    // to the first clone rather than silently to whichever happened to be last.
    if (d.localId && !localToNew.has(d.localId)) localToNew.set(d.localId, memberId);
    nodes.push({
      memberId,
      kind: d.kind,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      text: d.text,
      src: d.src,
      extra: d.extra,
      isConnector: false,
      localId: d.localId,
    });
  }
  const connectors: PlannedPlacement[] = [];
  for (const d of connectorDrafts) {
    const from = localToNew.get(d.fromLocalId!);
    const to = localToNew.get(d.toLocalId!);
    if (!from || !to) continue; // endpoint not in the pasted set → drop the dangling connector
    connectors.push({
      memberId: mintId(),
      kind: d.kind,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      text: d.text,
      src: d.src,
      extra: { ...(d.extra ?? {}), fromMemberId: from, toMemberId: to },
      isConnector: true,
    });
  }
  return [...nodes, ...connectors];
}

// ---------------------------------------------------------------------------
// Live clipboard store — module singleton so a copy survives board switches and
// crosses surface instances within the session (the "across boards" requirement).
// ---------------------------------------------------------------------------

let CLIPBOARD: BoardItemClipboard | null = null;

/** Stash a bundle as the current board clipboard. */
export function setBoardClipboard(clipboard: BoardItemClipboard | null): void {
  CLIPBOARD = clipboard;
}

/** Read the current board clipboard (null if nothing copied this session). */
export function getBoardClipboard(): BoardItemClipboard | null {
  return CLIPBOARD;
}

/** The system clipboard type a board bundle travels under, so a copy reaches another tab or window of Trillion. */
export const BOARD_CLIPBOARD_TYPE = 'application/x-trillion-board-items+json';

/** Writes a bundle to a copy event's clipboard under BOARD_CLIPBOARD_TYPE, with the items' words as plain text for any
 *  other app. */
export function writeBoardClipboard(data: DataTransfer, clipboard: BoardItemClipboard | null): void {
  if (!clipboard) return;
  data.setData(BOARD_CLIPBOARD_TYPE, JSON.stringify(clipboard));
  data.setData('text/plain', clipboard.items.map((item) => item.text ?? '').filter(Boolean).join('\n'));
}

/** The bundle a paste event carries, or null; an untrusted payload is accepted only in the bundle's own shape (paste
 *  still goes through clipboardToDrafts, which budgets and sanitizes every item). */
export function readBoardClipboard(data: DataTransfer): BoardItemClipboard | null {
  try {
    const value = JSON.parse(data.getData(BOARD_CLIPBOARD_TYPE) || 'null') as BoardItemClipboard | null;
    return value?.kind === 'board-item-clipboard' && value.version === 1 && Array.isArray(value.items) ? value : null;
  } catch { return null; }
}

/** How many items are on the clipboard right now (for HUD / enable-state). */
export function clipboardItemCount(): number {
  return CLIPBOARD?.items.length ?? 0;
}

// ---------------------------------------------------------------------------
// Live STYLE clipboard — the appearance-only sibling of the item clipboard.
// "Copy style" stashes one item's opaque visual-layer bundle here; "Paste style"
// stamps it onto a LATER, possibly different selection (the decoupled-in-time gap
// that apply-layers-to-all — same-selection only — structurally cannot fill).
// Also a module singleton, so a copied style survives board switches → paste-style
// works across boards within the session, exactly like the item clipboard.
// ---------------------------------------------------------------------------

let STYLE_CLIPBOARD: VisualLayerStackRecord | null = null;

/** Stash an item's visual-layer bundle as the current style clipboard. */
export function setStyleClipboard(bundle: VisualLayerStackRecord | null): void {
  STYLE_CLIPBOARD = bundle;
}

/** Read the copied style bundle (null if no style copied this session). */
export function getStyleClipboard(): VisualLayerStackRecord | null {
  return STYLE_CLIPBOARD;
}

/** True when a style is on the clipboard (gates the Paste-style row). */
export function hasStyleClipboard(): boolean {
  return STYLE_CLIPBOARD !== null;
}
