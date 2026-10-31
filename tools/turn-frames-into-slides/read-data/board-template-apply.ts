// tools/turn-frames-into-slides/read-data/board-template-apply.ts
//
// =============================================================================
// PURPOSE — apply a DATA-described board TEMPLATE onto a fresh board.
// =============================================================================
//
// A board template is pure DATA (a `BoardTemplate` row in the feature package's
// catalog, Society) — an array of self-describing item descriptors. This module
// is the ONE generic, blind applier: given any template, it creates a board and
// places each descriptor via the existing `placeItem`/`placeSection` primitives.
// It NEVER names a template, a kind, or a layout — adding a new template is one
// catalog row, ZERO change here (L069/L090). Deletion test: swap the catalog for
// a completely different one → this code is untouched.
//
// Two-pass id mapping (the #141 duplicateBoard idea): a connector descriptor
// references OTHER descriptors by their template-local `id` (`from`/`to`), so we
// mint every member id FIRST (pass 1), then place + remap connector endpoints to
// the minted ids (pass 2). Sections recurse (their children are placed inside the
// section's group). `mint` is injected → deterministic + unit-testable.
// =============================================================================

import type { GroupGraph } from './group-graph.ts';
import type { AddressRef } from './visual-layer-types.ts';
import { addBoard, boardRootRef, itemRef, placeItem, placeSection, sectionRef, setBoardBackground, setBoardAppearanceKey } from './group-board-model.ts';

/** One descriptor in a template. Self-describing DATA (L090) — the applier reads
 *  facets, never a closed kind set. A `children` array makes it a SECTION (its
 *  children are placed inside); `from`/`to` make it a CONNECTOR between two other
 *  descriptors' template-local ids. */
export interface TemplateItem {
  /** Template-local id — connector `from`/`to` reference it (remapped on apply). */
  readonly id: string;
  /** Raw kind DATA key (note/media/connector/section/…) — rendered by the kind registry. */
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text?: string;
  /** Anything else (visualLayerStack, color, etc.) — carried verbatim. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Present → this descriptor is a SECTION; these are placed inside it (nesting). */
  readonly children?: readonly TemplateItem[];
  /** Present → this descriptor is a CONNECTOR; endpoints are template-local ids. */
  readonly from?: string;
  readonly to?: string;
}

/** A named board template — pure DATA owned by the feature-package catalog. */
export interface BoardTemplate {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  /** One-line human summary shown under the title in the library card (R4). */
  readonly description?: string;
  /** Free-form labels for filtering + ranked search (R4). */
  readonly tags?: readonly string[];
  readonly items: readonly TemplateItem[];
  /** cont.26 — an optional board-level LOOK the template pre-configures on the new board: a surface
   *  `background` catalog id (from `board-backgrounds.ts`) and/or an `appearance` defaults profile
   *  (the same cascade bag `setBoardAppearanceKey` writes — e.g. a sketch profile). Applied via the
   *  shipped `setBoardBackground`/`setBoardAppearanceKey` primitives, zero model change. So a
   *  "Sketch whiteboard" template opens a board that is ALREADY a paper canvas with pencil notes.
   *  Absent → the board keeps the defaults (dots surface, no appearance overrides) — zero regression. */
  readonly background?: string;
  readonly appearance?: Readonly<Record<string, unknown>>;
}

/** Deepest section nesting the applier will materialize. `children` recurses (pass 1 AND pass 2),
 *  and a template can arrive UNTRUSTED — a snapshot artifact's `producer.input` is raw DATA parsed
 *  from the `arrangement-lens-catalog` published records (it bypasses collection-store's own parse).
 *  A crafted 50k-deep `children` chain would stack-overflow `mapIds`/`placeInto` (a RangeError DoS).
 *  Bounding pass 1 fails such a template CLOSED with a named error before any member is minted or
 *  placed; 256 is far beyond any real section tree, so no legitimate template is rejected. Because
 *  `materializeItems` runs this pass BEFORE `placeInto`, one cap here guards BOTH recursive passes. */
const MAX_TEMPLATE_DEPTH = 256;

/** Pass 1 — mint a fresh member id for every descriptor across the whole tree, so
 *  connector endpoints can be remapped before any connector is placed. FAIL-CLOSED on
 *  over-deep nesting (DoS guard) and on a DUPLICATE template-local id: the applier mints
 *  one member per id and remaps connectors BY id, so two descriptors sharing an id are
 *  ambiguous — the second would overwrite the first's mapping (wrong connector remap) then
 *  collide on placement. A named throw here rejects it early, matching the uniqueness the
 *  collection-store parser already enforces, now also guarded on the snapshot-input path. */
function mapIds(items: readonly TemplateItem[], mint: () => string, map: Map<string, string>, depth = 0): void {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new Error(`board template nesting exceeds ${MAX_TEMPLATE_DEPTH} levels`);
  }
  for (const it of items) {
    if (map.has(it.id)) {
      throw new Error(`duplicate template-local id "${it.id}"`);
    }
    map.set(it.id, mint());
    if (it.children) mapIds(it.children, mint, map, depth + 1);
  }
}

/** Pass 2 — place each descriptor into `parentRef`, recursing into sections and
 *  remapping connector endpoints to the pass-1 minted ids. */
function placeInto(
  graph: GroupGraph,
  boardId: string,
  parentRef: AddressRef,
  items: readonly TemplateItem[],
  map: Map<string, string>,
  mint: () => string,
): GroupGraph {
  let g = graph;
  for (const it of items) {
    const memberId = map.get(it.id);
    if (!memberId) continue;
    if (it.children) {
      const secRef = sectionRef(boardId, mint());
      g = placeSection(g, parentRef, {
        memberId,
        sectionNodeRef: secRef,
        x: it.x,
        y: it.y,
        w: it.w,
        h: it.h,
        text: it.text,
        extra: it.extra ? { ...it.extra } : undefined, // frame styling survives (border/aspect/caption)
      });
      g = placeInto(g, boardId, secRef, it.children, map, mint);
    } else {
      const extra: Record<string, unknown> = { ...(it.extra ?? {}) };
      // A connector's template-local endpoints may be encoded as `from`/`to` OR carried on
      // `extra.fromMemberId`/`extra.toMemberId` — the live-board shape a SAVED COLLECTION keeps,
      // and the shape a hand-authored template may use. Read whichever is present and remap BOTH
      // to the minted ids. FAIL-CLOSED: if the item is a connector but an endpoint can't be
      // remapped, DROP it (never place a dangling / half connector that points at a vanished id).
      const srcLocal = it.from ?? (typeof extra.fromMemberId === 'string' ? extra.fromMemberId : undefined);
      const dstLocal = it.to ?? (typeof extra.toMemberId === 'string' ? extra.toMemberId : undefined);
      // A connector is defined by BOTH endpoints (the canonical `isConnectorItem` predicate in
      // group-board-model requires fromMemberId AND toMemberId). Only a both-endpoints descriptor is a
      // connector-remap candidate — an item carrying just ONE stray endpoint key (e.g. a note whose
      // opaque `extra.fromMemberId` survived a copy, or a crafted record) is NOT a connector and must
      // fall through to normal placement, NOT be deleted. With the old OR condition a single stray
      // `extra.fromMemberId` sent a plain note into this branch and the `dstLocal === undefined` arm
      // dropped it entirely (silent content loss). Both endpoints present but either unresolvable →
      // still dropped (a genuine dangling connector, fail-closed — never a half connector to a vanished id).
      if (srcLocal !== undefined && dstLocal !== undefined) {
        if (!map.has(srcLocal) || !map.has(dstLocal)) {
          continue; // dangling connector → drop it entirely (fail-closed)
        }
        extra.fromMemberId = map.get(srcLocal);
        extra.toMemberId = map.get(dstLocal);
      }
      g = placeItem(g, parentRef, {
        memberId,
        nodeRef: itemRef(boardId, mint()),
        kind: it.kind,
        x: it.x,
        y: it.y,
        w: it.w,
        h: it.h,
        text: it.text,
        extra,
      });
    }
  }
  return g;
}

/**
 * THE SSOT deep-copy engine (L030/L063): materialize a `TemplateItem[]` tree into
 * `parentRef` on `boardId` — mint fresh ids for the whole tree (pass 1), then place +
 * remap connector endpoints + recurse sections (pass 2). Both the template applier
 * (`applyTemplate`, source = catalog DATA) and the live-board deep-copy
 * (`copyBoardContents` → `boardToTemplate`, source = a live board) route through this
 * ONE function, so connector-remap / section-nesting / styled-frame fidelity lives in
 * exactly one place. Pure: `mint` injected; the source items are never mutated.
 */
export function materializeItems(
  graph: GroupGraph,
  boardId: string,
  parentRef: AddressRef,
  items: readonly TemplateItem[],
  mint: () => string,
): GroupGraph {
  const map = new Map<string, string>();
  mapIds(items, mint, map);
  return placeInto(graph, boardId, parentRef, items, map, mint);
}

/**
 * Create a new board from a template and place all of its descriptor items.
 * Pure (ids injected via `mint`); the source template is never mutated.
 */
export function applyTemplate(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { template: BoardTemplate; newBoardId: string; newMemberId: string; title?: string; mint: () => string },
): GroupGraph {
  const withBoard = addBoard(graph, indexRef, {
    memberId: args.newMemberId,
    boardId: args.newBoardId,
    title: args.title ?? args.template.name,
  });
  // cont.26 — apply the template's optional board-level LOOK (surface background + appearance-defaults
  // profile) to the new board's index member via the SAME shipped primitives the picker/preset use
  // (zero model change). So a "Sketch whiteboard" template opens a full paper-canvas + pencil board in
  // one click. Absent fields → the board keeps its defaults (dots surface, no overrides) — unchanged.
  let withLook = withBoard;
  if (args.template.background) {
    withLook = setBoardBackground(withLook, indexRef, args.newMemberId, args.template.background);
  }
  if (args.template.appearance) {
    for (const [key, value] of Object.entries(args.template.appearance)) {
      withLook = setBoardAppearanceKey(withLook, indexRef, args.newMemberId, key, value);
    }
  }
  return materializeItems(withLook, args.newBoardId, boardRootRef(args.newBoardId), args.template.items, args.mint);
}
