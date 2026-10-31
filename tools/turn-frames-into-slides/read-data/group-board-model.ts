// tools/turn-frames-into-slides/read-data/group-board-model.ts
//
// The pure board logic for the spatial board canvas (generic model,
// Freeform/Pinterest/Craft anatomy). A board is a group; an ITEM is a group
// member whose opaque `presentation` carries its kind + world-space rectangle +
// content (the leaf/core never reads it). This module owns ONLY the board's
// item vocabulary; the leaf and EEAF stay blind. No I/O, no React.
//
// WHY POSITION LIVES IN presentation
// The group leaf stores membership + opaque presentation. A positioned canvas item
// stores its {kind,x,y,w,h,content} in presentation — persisted verbatim by the
// group EEAF, with ZERO leaf changes.
// New item kinds = a renderer-registry DATA row, never a model/leaf edit (L069/L090).

import {
  addMember,
  ensureGroup,
  getGroup,
  groupKey,
  groupMembers,
  membersOf,
  moveMember,
  reaches,
  removeMember,
  setMemberFields,
  ungroupMembers,
  type AddressRef,
  type GroupGraph,
} from './group-graph.ts';
// The SSOT deep-copy engine + its DATA descriptor type. `materializeItems` is used only
// INSIDE `copyBoardContents`' body (never at module top-level), so the resulting
// function-level import cycle with board-template-apply is benign under ESM/esbuild.
import { materializeItems, type TemplateItem } from './board-template-apply.ts';

const BOARD_FAMILY = 'group.board';
const ITEM_FAMILY = 'group.item';
const INDEX_FAMILY = 'group.board-index';

/** The root group ref for a board id. The board surface opens at this ref. */
export function boardRootRef(boardId: string): AddressRef {
  return { family: BOARD_FAMILY, parts: { board: boardId } };
}

/**
 * The board-INDEX ref for a surface. A surface holds MANY boards; the index is a
 * group whose members each point at a board's own root group (`boardRootRef`) —
 * so a single store rooted here loads the index AND every board's items in one
 * BFS, with ZERO new persistence (a board is just a group member, the leaf's I2).
 * Keyed by the surface's default board id so generic surfaces stay isolated.
 */
export function boardIndexRef(indexId: string): AddressRef {
  return { family: INDEX_FAMILY, parts: { index: indexId } };
}

/**
 * A calendar cadence for auto-rolling boards. Closed by Physics (the Gregorian
 * calendar has a fixed set of bucket units), so this is a permitted finite set —
 * NOT an extensible Society enum. A surface opts into a cadence via mount DATA.
 */
export type CadenceUnit = 'day' | 'week' | 'month' | 'year';

/** One board in the index (decoded from an index member). `boardId` selects its root. */
export interface BoardEntry {
  readonly memberId: string;
  readonly boardId: string;
  readonly title: string;
  /** True iff the board is archived — hidden from the active switcher, restorable. */
  readonly archived: boolean;
  /** Set iff this board was auto-created by a calendar cadence (drives stale-rollover). */
  readonly cadenceUnit?: CadenceUnit;
  /** The cadence time-bucket this board owns (e.g. "2026-06-27"); lexically sortable. */
  readonly bucketKey?: string;
  /** The board's chosen surface look — a catalog id (see `board-backgrounds.ts`).
   *  Absent → the renderer's default (the dot grid). Self-describing board DATA,
   *  exactly like an item carries `extra.*`; the board IS a member of the index. */
  readonly background?: string;
  /** True iff this board opts into snap-to-grid while dragging (#202). A per-board
   *  DATA flag on the index member, exactly like {@link background}; absent → off
   *  (peer-edge smart guides still apply — the grid is an ADDITIONAL, opt-in source). */
  readonly gridSnap?: boolean;
  /** #225 (P1) — the board's appearance-defaults profile: the MIDDLE tier of the
   *  item-appearance cascade (item override → THIS → global). An opaque key bag
   *  (`{ sizeMode: 'scroll', containerVariant: 'ghost', … }`) — the model never
   *  enumerates keys (L090); `item-appearance.resolveAppearanceKey` consumes it. */
  readonly appearance?: Record<string, unknown>;
  /** The board's goal-hierarchy relation for the rollup lens: `{ relationKind, childEndpoint }`, a DATA
   *  descriptor on the index member (like {@link background}). Absent → rollup off (no default kind — a
   *  bare link is too ambiguous to be hierarchy). Validated by `board-rollup-actions.rollupSpecFromRaw`. */
  readonly rollupSpec?: Record<string, unknown>;
}

/** Read EVERY board registered in an index, in order (active + archived). Blind to
 *  board contents. Callers split on `archived` for the switcher vs the archive view. */
export function readBoards(graph: GroupGraph, indexRef: AddressRef): BoardEntry[] {
  return membersOf(graph, indexRef).map((member): BoardEntry => {
    const p = (member.presentation ?? {}) as Record<string, unknown>;
    return {
      memberId: member.memberId,
      boardId: typeof p.boardId === 'string' ? p.boardId : (member.nodeRef.parts?.board ?? ''),
      title: typeof p.text === 'string' && p.text ? p.text : 'Untitled board',
      archived: p.archived === true,
      cadenceUnit: typeof p.cadenceUnit === 'string' ? (p.cadenceUnit as CadenceUnit) : undefined,
      bucketKey: typeof p.bucketKey === 'string' ? p.bucketKey : undefined,
      background: typeof p.background === 'string' ? p.background : undefined,
      gridSnap: p.gridSnap === true ? true : undefined,
      appearance:
        typeof p.appearance === 'object' && p.appearance !== null && !Array.isArray(p.appearance)
          ? (p.appearance as Record<string, unknown>)
          : undefined,
      rollupSpec:
        typeof p.rollupSpec === 'object' && p.rollupSpec !== null && !Array.isArray(p.rollupSpec)
          ? (p.rollupSpec as Record<string, unknown>)
          : undefined,
    };
  });
}

/** The active (non-archived) boards — what the switcher lists. */
export function readActiveBoards(graph: GroupGraph, indexRef: AddressRef): BoardEntry[] {
  return readBoards(graph, indexRef).filter((b) => !b.archived);
}

/** The archived boards — what the archive view lists (restorable). */
export function readArchivedBoards(graph: GroupGraph, indexRef: AddressRef): BoardEntry[] {
  return readBoards(graph, indexRef).filter((b) => b.archived);
}

/** True iff a board id is already registered in the index. */
export function hasBoard(graph: GroupGraph, indexRef: AddressRef, boardId: string): boolean {
  return readBoards(graph, indexRef).some((b) => b.boardId === boardId);
}

/**
 * Register a board in the index WITHOUT touching its root group. Use this to adopt
 * a board whose root may ALREADY hold items (e.g. seeding the default board): it
 * writes only the index member, so a later reload's BFS follows the index into the
 * existing root and preserves its items (never overwrites them with an empty group).
 */
export function addBoardEntry(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; boardId: string; title: string },
): GroupGraph {
  if (hasBoard(graph, indexRef, args.boardId)) return graph;
  const withIndex = ensureGroup(graph, indexRef);
  return addMember(withIndex, indexRef, boardRootRef(args.boardId), {
    memberId: args.memberId,
    presentation: { kind: 'board', boardId: args.boardId, text: args.title },
  });
}

/**
 * Create a NEW board: register it in the index AND ensure its own empty root group
 * so the brand-new (empty) board persists with childCount 0. Only safe for a board
 * id with no pre-existing root — use {@link addBoardEntry} to adopt an existing one.
 */
export function addBoard(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; boardId: string; title: string },
): GroupGraph {
  if (hasBoard(graph, indexRef, args.boardId)) return graph;
  return ensureGroup(addBoardEntry(graph, indexRef, args), boardRootRef(args.boardId));
}

/** Rename a board in the index (the title shown in the switcher). */
export function renameBoard(graph: GroupGraph, indexRef: AddressRef, memberId: string, title: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, text: title } });
}

/**
 * Set a board's surface look (a catalog id from `board-backgrounds.ts`). Writes
 * only `presentation.background` on the board's index member — the same single-
 * field index mutation as {@link renameBoard}/{@link archiveBoard}, so it commits
 * and persists through the identical path. Blind to what the id means (Society
 * DATA resolved at render); the model only stores the chosen id.
 */
export function setBoardBackground(graph: GroupGraph, indexRef: AddressRef, memberId: string, background: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, background } });
}

/**
 * Set (or clear with `null`) a board's goal-hierarchy relation for the rollup lens — writes
 * `presentation.rollupSpec` on the board's index member, the same single-field index mutation as
 * {@link setBoardBackground}. Blind to what the relation means (the descriptor is validated + consumed
 * by `board-rollup-actions`); the model only stores the chosen `{ relationKind, childEndpoint }`.
 */
export function setBoardRollupSpec(graph: GroupGraph, indexRef: AddressRef, memberId: string, spec: { relationKind: string; childEndpoint: 'from' | 'to' } | null): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, rollupSpec: spec ?? undefined } });
}

/**
 * #225 (P1) — set ONE key in a board's appearance-defaults profile (the middle
 * cascade tier). Merges by key so setting `sizeMode` never clobbers a previously
 * chosen `containerVariant`; `undefined` DELETES the key (the board falls back to
 * the global default — "reset to default" is first-class, not a sentinel value).
 * Same single-field index-member write as {@link setBoardBackground}; blind to
 * what the key means (item-appearance resolves it at render).
 */
export function setBoardAppearanceKey(
  graph: GroupGraph,
  indexRef: AddressRef,
  memberId: string,
  key: string,
  value: unknown,
): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  const existing =
    typeof current.appearance === 'object' && current.appearance !== null && !Array.isArray(current.appearance)
      ? (current.appearance as Record<string, unknown>)
      : {};
  const appearance = { ...existing };
  if (value === undefined) delete appearance[key];
  else appearance[key] = value;
  return setMemberFields(graph, indexRef, memberId, {
    presentation: { ...current, appearance: Object.keys(appearance).length > 0 ? appearance : undefined },
  });
}

/**
 * #225 (P1, R2 "presets") — apply an appearance PRESET (a named bag of cascade
 * keys) to a board: fold each meaningful key of `profile` through
 * {@link setBoardAppearanceKey}, so the board's appearance-defaults adopt the
 * whole look at once. Takes a plain key bag (NOT the `AppearancePreset` type,
 * which lives in `show/` — read-data stays free of show-layer deps); the show
 * layer passes `preset.profile`. Empty/null values DELETE their key (reset to
 * global default), matching setBoardAppearanceKey. Keys applied in sorted order
 * for deterministic writes. An empty/absent profile is a no-op (graph unchanged).
 */
export function applyAppearanceProfileToBoard(
  graph: GroupGraph,
  indexRef: AddressRef,
  memberId: string,
  profile: Record<string, unknown> | undefined,
): GroupGraph {
  if (!profile || typeof profile !== 'object') return graph;
  return Object.keys(profile)
    .sort()
    .reduce((g, key) => setBoardAppearanceKey(g, indexRef, memberId, key, profile[key]), graph);
}

/**
 * Toggle a board's snap-to-grid-while-dragging preference (#202). Writes only
 * `presentation.gridSnap` on the board's index member — the same single-field index
 * mutation as {@link setBoardBackground}. Stored as a plain boolean the drag handler
 * reads to decide whether to add the fixed-grid snap source; absent/false → off.
 */
export function setBoardGridSnap(graph: GroupGraph, indexRef: AddressRef, memberId: string, gridSnap: boolean): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, gridSnap } });
}

/**
 * Archive a board (recoverable soft-delete): flag its index entry `archived:true`
 * so it leaves the active switcher but stays in the index — its items are untouched
 * and it can be restored. Matches the codebase's soft-archive pattern (#42).
 */
export function archiveBoard(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, archived: true } });
}

/** Restore an archived board back into the active switcher (clears the flag). */
export function restoreBoard(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, archived: false } });
}

/**
 * Permanently unregister a board from the index (its root becomes unreachable). Used
 * for "delete forever" from the archive — distinct from the recoverable archive above.
 */
export function removeBoard(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return removeMember(graph, indexRef, memberId);
}

// ─── Calendar cadence: auto-rolling daily/weekly/monthly boards ──────────────────
// A surface can opt into a cadence (mount DATA). On open it ensures the current
// time-bucket's board exists and retires stale ones — a fresh board per period with
// the old ones rolling into the archive. The cadence unit drives ALL of this from a
// pure date function; the panel stays blind to "what a day is".

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ISO-8601 week-of-year for a date (Mon-based, week 1 holds the first Thursday). */
function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to the week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ftDayNum) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * The lexically-sortable bucket key a date falls into under a cadence unit (UTC).
 * Same unit → string `<` compares as chronological order (used for stale-rollover).
 */
export function cadenceBucket(unit: CadenceUnit, date: Date): string {
  const y = date.getUTCFullYear();
  switch (unit) {
    case 'day':
      return `${y}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
    case 'week': {
      const w = isoWeek(date);
      return `${w.year}-W${pad2(w.week)}`;
    }
    case 'month':
      return `${y}-${pad2(date.getUTCMonth() + 1)}`;
    case 'year':
      return `${y}`;
  }
}

/** The human title shown in the switcher for a cadence board's bucket. */
export function cadenceTitle(unit: CadenceUnit, bucketKey: string): string {
  switch (unit) {
    case 'day': {
      const [y, m, d] = bucketKey.split('-');
      return `${MONTH_NAMES[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
    }
    case 'week': {
      const [y, w] = bucketKey.split('-W');
      return `Week ${Number(w)}, ${y}`;
    }
    case 'month': {
      const [y, m] = bucketKey.split('-');
      return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
    }
    case 'year':
      return bucketKey;
  }
}

/** The boardId a cadence board owns — encodes its unit + bucket so it is idempotent. */
export function cadenceBoardId(unit: CadenceUnit, bucketKey: string): string {
  return `${unit}-${bucketKey}`;
}

/**
 * Ensure the board for `date`'s bucket under `unit` exists (idempotent). Brand-new
 * cadence boards are tagged with `cadenceUnit`/`bucketKey` DATA so stale-rollover can
 * find them. Returns the (possibly unchanged) graph + the bucket's boardId + whether
 * it was just created.
 */
export function ensureCadenceBoard(
  graph: GroupGraph,
  indexRef: AddressRef,
  unit: CadenceUnit,
  date: Date,
  args: { memberId: string },
): { graph: GroupGraph; boardId: string; created: boolean } {
  const bucketKey = cadenceBucket(unit, date);
  const boardId = cadenceBoardId(unit, bucketKey);
  if (hasBoard(graph, indexRef, boardId)) return { graph, boardId, created: false };
  const withBoard = addBoard(graph, indexRef, { memberId: args.memberId, boardId, title: cadenceTitle(unit, bucketKey) });
  const current = (getGroup(withBoard, indexRef)?.members[args.memberId]?.presentation ?? {}) as Record<string, unknown>;
  const tagged = setMemberFields(withBoard, indexRef, args.memberId, { presentation: { ...current, cadenceUnit: unit, bucketKey } });
  return { graph: tagged, boardId, created: true };
}

/**
 * Retire cadence boards older than the current bucket so the switcher shows only the
 * live period(s). Keeps the `keepActive` most-recent buckets active (default 1 = only
 * the current). A retired board that is EMPTY is removed outright (no junk archive
 * entries for days you never used); one with content is archived (recoverable). Only
 * touches boards tagged with this same `unit` — manual boards are never affected.
 */
export function archiveStaleCadenceBoards(
  graph: GroupGraph,
  indexRef: AddressRef,
  unit: CadenceUnit,
  currentBucketKey: string,
  keepActive = 1,
): GroupGraph {
  const older = readActiveBoards(graph, indexRef)
    .filter((b) => b.cadenceUnit === unit && b.bucketKey !== undefined && b.bucketKey < currentBucketKey)
    .sort((a, b) => (a.bucketKey! < b.bucketKey! ? 1 : a.bucketKey! > b.bucketKey! ? -1 : 0)); // newest-older first
  const toRetire = older.slice(Math.max(0, keepActive - 1));
  let next = graph;
  for (const b of toRetire) {
    next = isBoardEmpty(next, boardRootRef(b.boardId))
      ? removeBoard(next, indexRef, b.memberId)
      : archiveBoard(next, indexRef, b.memberId);
  }
  return next;
}

/** An item is a leaf node (never a group) — its content lives in member.presentation. */
export function itemRef(boardId: string, itemId: string): AddressRef {
  return { family: ITEM_FAMILY, parts: { board: boardId, item: itemId } };
}

/** A nested section/folder is itself a group (infinite nesting — the leaf's I2). */
export function sectionRef(boardId: string, sectionId: string): AddressRef {
  return { family: BOARD_FAMILY, parts: { board: boardId, section: sectionId } };
}

/**
 * One placed board item, decoded from a member's opaque presentation.
 * `kind` is a RAW DATA KEY (L090) — the canvas renders it via a kind→renderer
 * registry, never a closed union or `if(kind===)`.
 */
export interface BoardItem {
  readonly memberId: string;
  readonly nodeRef: AddressRef;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Human text (note title/body, item caption). For a rich note this is the plain
   *  projection of {@link html} (previews, section titles, search). */
  readonly text?: string;
  /** Rich HTML body for a note (composition-grade). Absent → plain {@link text}. */
  readonly html?: string;
  /** A content reference the renderer resolves (image src, media ref, or opaque reference). */
  readonly src?: string;
  /** True iff this member is itself a group in this graph → a nested section. */
  readonly isSection: boolean;
  /** How many items live inside this section (0 for non-sections) — drives the count badge. */
  readonly childCount: number;
  /** Anything else the owner attached — renderers may read it, the core never does. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * Structural (shape-based, L090) test for a connector member: it carries both
 * `extra.fromMemberId` and `extra.toMemberId` (the #98 relationship shape). The ONE
 * canonical predicate — partition by SHAPE, never by a `kind === 'connector'` string
 * literal, so any relation kind is treated as an edge without naming "connector".
 * Imported by GroupBoardPanel (selection gating) and batch-actions (`arrangeMindMap`).
 */
export function itemIsConnector(item: BoardItem): boolean {
  return typeof item.extra?.fromMemberId === 'string' && typeof item.extra?.toMemberId === 'string';
}

/**
 * The ONE canonical lock predicate — an item is locked when `extra.locked === true`
 * (the #135/#136 lock contract). Every mutation guard (nudge, delete, drag, group
 * resize/rotate, batch op, duplicate, alt-drag) asks THIS, so the lock rule lives in
 * one place (L030/SSOT) instead of ~24 scattered `extra?.locked === true` literals.
 * If lock ever grows richer (levels, reasons) it changes here, not at every call site.
 * Absent/non-true → unlocked (back-compat: every legacy item is freely editable).
 */
export function itemIsLocked(item: BoardItem): boolean {
  return item.extra?.locked === true;
}

/** A live package surface an item mounts as its content: a name pair (which
 *  package + which entry) plus optional surface input. DATA only — group never
 *  names the product. */
export interface PlaceableSurfaceRef {
  readonly packageName: string;
  readonly entryName: string;
  readonly surfaceInput?: Record<string, unknown>;
}

/**
 * The ONE canonical reader for an item's live-surface DATA. An item mounts a live
 * package surface (a dashboard, chat, leaderboard, …) as its content when
 * `extra.placeableSurface` carries a valid `{ packageName, entryName }` name pair.
 * Blind: this returns only the address DATA — it never inspects or names the
 * product. Absent / malformed → null (the item renders as a normal note/image/etc.).
 */
export function readPlaceableSurface(item: BoardItem): PlaceableSurfaceRef | null {
  const raw = item.extra?.placeableSurface;
  if (!raw || typeof raw !== 'object') return null;
  const { packageName, entryName, surfaceInput } = raw as Record<string, unknown>;
  if (typeof packageName !== 'string' || !packageName) return null;
  if (typeof entryName !== 'string' || !entryName) return null;
  return {
    packageName,
    entryName,
    surfaceInput:
      surfaceInput && typeof surfaceInput === 'object'
        ? (surfaceInput as Record<string, unknown>)
        : undefined,
  };
}

/**
 * The real MIME the item's bytes were stored with — the ONE place this is
 * derived (image-vs-video render, immersive viewer). `image/*` when absent so a
 * src with no recorded type still renders as an image.
 */
export function boardItemContentType(item: BoardItem): string {
  const t = item.extra?.contentType;
  return typeof t === 'string' && t.length > 0 ? t : 'image/*';
}

const DEFAULTS = { w: 220, h: 160 } as const;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Decode every member of a group into a positioned BoardItem (blind to kind). */
export function readItems(graph: GroupGraph, ref: AddressRef): BoardItem[] {
  return membersOf(graph, ref).map((member): BoardItem => {
    const p = (member.presentation ?? {}) as Record<string, unknown>;
    const childGroup = getGroup(graph, member.nodeRef);
    return {
      memberId: member.memberId,
      nodeRef: member.nodeRef,
      kind: typeof p.kind === 'string' && p.kind ? p.kind : 'note',
      x: num(p.x, 0),
      y: num(p.y, 0),
      w: num(p.w, DEFAULTS.w),
      h: num(p.h, DEFAULTS.h),
      text: typeof p.text === 'string' ? p.text : undefined,
      html: typeof p.html === 'string' ? p.html : undefined,
      src: typeof p.src === 'string' ? p.src : undefined,
      isSection: !!childGroup,
      childCount: childGroup?.memberOrder.length ?? 0,
      // A COPY, never the live presentation object: the graph is immutable (I3), so a caller mutating
      // `item.extra` (e.g. `item.extra.toMemberId = ...`) must not corrupt the source graph.
      extra: { ...p },
    };
  });
}

/** Place a new typed item on the board canvas at (x,y). Caller supplies ids (leaf I3). */
export function placeItem(
  graph: GroupGraph,
  parentRef: AddressRef,
  args: {
    memberId: string;
    nodeRef: AddressRef;
    kind: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    text?: string;
    src?: string;
    extra?: Record<string, unknown>;
  },
): GroupGraph {
  const ready = ensureGroup(graph, parentRef);
  // The typed core args are AUTHORITATIVE — `extra` is supplementary data and must never override the
  // geometry/identity. If `extra` were spread last, an untrusted item (a shared capsule or an imported
  // template carrying `extra: { x: 999, kind: 'connector' }`) would silently corrupt its own placement or
  // flip its kind. Build the defined core fields first, then spread extra UNDER them (core wins). text/src
  // are pruned when absent, so a rare extra.text is not clobbered by an undefined arg.
  const core = pruneUndefined({
    kind: args.kind,
    x: args.x,
    y: args.y,
    w: args.w ?? DEFAULTS.w,
    h: args.h ?? DEFAULTS.h,
    text: args.text,
    src: args.src,
  });
  const presentation = pruneUndefined({ ...(args.extra ?? {}), ...core });
  return addMember(ready, parentRef, args.nodeRef, { memberId: args.memberId, presentation });
}

/** The full arg shape one placed item carries — identical to {@link placeItem}'s `args`. */
export interface PlaceItemArgs {
  memberId: string;
  nodeRef: AddressRef;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  src?: string;
  extra?: Record<string, unknown>;
}

/**
 * BATCH item placement — the O(M+K) sibling of {@link placeItem}. A paste / capsule-import / duplicate /
 * clone folds `placeItem` per item, and each `placeItem -> addMember` does `{ ...group.members, [id]: m }`
 * plus a `memberOrder` rebuild — O(M) PER item, so placing K items into an M-member board is O(K*M) =
 * O(N^2) on a large paste, freezing the commit path. This spreads the members map ONCE and appends
 * `memberOrder` ONCE -> O(M+K). Every existing member keeps its reference identity (structural sharing, P1).
 *
 * SEMANTICS: identical to `items.reduce((g, a) => placeItem(g, parentRef, a), graph)` for the paste/clone
 * use case (freshly minted nodeRefs, default end-placement) — same core-wins presentation build, same
 * append order, same final graph shape (mirrors the leaf `ensureGroup` + `addMember` + `withGroup`). Two
 * divergences, both safer for a batch and UNREACHABLE in a real paste (whose memberIds/nodeRefs are freshly
 * minted + unique): a DUPLICATE memberId (already present, incl. earlier in THIS batch) is SKIPPED, not
 * thrown; an item whose nodeRef would form a CYCLE (its subtree already contains the parent) is SKIPPED.
 * `placeItem`/`addMember` throw in both cases — skipping means one bad item cannot abort the whole paste.
 * Pure graph -> graph; an empty / all-skipped batch returns the SAME graph reference.
 */
export function placeItems(graph: GroupGraph, parentRef: AddressRef, items: ReadonlyArray<PlaceItemArgs>): GroupGraph {
  if (items.length === 0) return graph;
  const ready = ensureGroup(graph, parentRef);
  const base = getGroup(ready, parentRef);
  if (!base) return graph; // ensureGroup guarantees a group; guard keeps the type non-null + fails closed
  const nextMembers = { ...base.members }; // ONE O(M) spread for the whole batch (not O(M) per item)
  const appended: string[] = [];
  for (const a of items) {
    if (a.memberId in nextMembers) continue; // duplicate (never in a real paste) — skip, do not abort the batch
    if (reaches(ready, a.nodeRef, parentRef)) continue; // cycle (never for a fresh leaf ref) — skip
    const core = pruneUndefined({
      kind: a.kind,
      x: a.x,
      y: a.y,
      w: a.w ?? DEFAULTS.w,
      h: a.h ?? DEFAULTS.h,
      text: a.text,
      src: a.src,
    });
    // core wins over extra — identity/geometry are authoritative, exactly like placeItem.
    const presentation = pruneUndefined({ ...(a.extra ?? {}), ...core });
    nextMembers[a.memberId] = pruneUndefined({ memberId: a.memberId, nodeRef: a.nodeRef, presentation });
    appended.push(a.memberId);
  }
  if (appended.length === 0) return graph; // nothing placed → identical graph reference
  return {
    groups: {
      ...ready.groups,
      [groupKey(parentRef)]: { groupRef: base.groupRef, memberOrder: [...base.memberOrder, ...appended], members: nextMembers },
    },
  };
}

/** A member to add with its presentation set VERBATIM (opaque) — the shape a producer emits. */
export interface VerbatimMember {
  memberId: string;
  nodeRef: AddressRef;
  presentation: Readonly<Record<string, unknown>>;
}

/**
 * BATCH verbatim member add — the O(M+K) sibling of the leaf `addMember` for callers that already hold a
 * finished, OPAQUE presentation (a producer's emitted items) rather than the typed {@link placeItem} args.
 * `placeItems` can NOT be reused here: it REBUILDS presentation from typed kind/x/y fields, whereas this sets
 * the presentation VERBATIM. Spreads the members map ONCE + appends `memberOrder` ONCE -> O(M+K); existing
 * members keep reference identity (P1). Skips a duplicate memberId (already present) or a CYCLE (`reaches`) —
 * matching `addMember`'s guards but fail-closed (skip, not throw). Semantically identical to folding
 * `addMember` with each member's verbatim presentation. Assumes the batch's memberIds are unique (a producer
 * emits unique ids). Pure; empty / all-skipped returns the SAME graph reference (after `ensureGroup`).
 */
export function addMembersVerbatim(graph: GroupGraph, parentRef: AddressRef, members: ReadonlyArray<VerbatimMember>): GroupGraph {
  const ready = ensureGroup(graph, parentRef); // ensure first (empty-target first run), like addMember
  if (members.length === 0) return ready;
  const base = getGroup(ready, parentRef);
  if (!base) return ready;
  const nextMembers = { ...base.members }; // ONE O(M) spread for the whole batch
  const appended: string[] = [];
  for (const m of members) {
    if (m.memberId in nextMembers) continue; // duplicate → skip
    if (reaches(ready, m.nodeRef, parentRef)) continue; // cycle → skip
    // Prune undefined presentation keys — the SAME semantics placeItem/patchItems apply
    // (pruneUndefined), so `key: undefined` means "absent" on EVERY write path. Without
    // this, a producer emitting `extra: undefined` (the nested-encoding tombstone) would
    // store a literal own-key undefined that `'extra' in presentation` still sees.
    nextMembers[m.memberId] = pruneUndefined({ memberId: m.memberId, nodeRef: m.nodeRef, presentation: pruneUndefined({ ...m.presentation }) });
    appended.push(m.memberId);
  }
  if (appended.length === 0) return ready; // nothing added → the ensured graph
  return {
    groups: {
      ...ready.groups,
      [groupKey(parentRef)]: { groupRef: base.groupRef, memberOrder: [...base.memberOrder, ...appended], members: nextMembers },
    },
  };
}

/**
 * Spawn a NEW note at (x,y) AND a connector linking `fromMemberId` → that new note, in one
 * pure graph transform (the mind-map "drag off a node to spawn a child" move, #159). Returns
 * the combined graph + the new note's memberId so the caller can select/edit it. All four ids
 * are INJECTED (note member/item, connector member/item) so this stays pure + deterministic —
 * the gesture shell supplies fresh ids, the test supplies fixed ones. Composes `placeItem`
 * twice (note then connector); zero new representation — the connector is the SAME
 * `kind:'connector'` member carrying `extra.from/toMemberId` that #98 created.
 */
export function connectNewNote(
  graph: GroupGraph,
  boardRef: AddressRef,
  opts: {
    boardId: string;
    fromMemberId: string;
    x: number;
    y: number;
    noteMemberId: string;
    noteItemId: string;
    connectorMemberId: string;
    connectorItemId: string;
    text?: string;
  },
): { graph: GroupGraph; noteMemberId: string } {
  const withNote = placeItem(graph, boardRef, {
    memberId: opts.noteMemberId,
    nodeRef: itemRef(opts.boardId, opts.noteItemId),
    kind: 'note',
    x: Math.round(opts.x),
    y: Math.round(opts.y),
    text: opts.text ?? '',
  });
  const withConnector = placeItem(withNote, boardRef, {
    memberId: opts.connectorMemberId,
    nodeRef: itemRef(opts.boardId, opts.connectorItemId),
    kind: 'connector',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    extra: { fromMemberId: opts.fromMemberId, toMemberId: opts.noteMemberId },
  });
  return { graph: withConnector, noteMemberId: opts.noteMemberId };
}

/** Move an item to a new world-space position (drag). Merges into presentation. */
export function moveItem(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberId: string,
  x: number,
  y: number,
): GroupGraph {
  return patchItem(graph, parentRef, memberId, { x, y });
}

/** The smallest an item may be resized to — keeps a card usable/grabbable. */
export const MIN_ITEM_W = 96;
export const MIN_ITEM_H = 56;

/** Resize an item's bounding box (persisted w/h), clamped to a usable minimum in
 *  ONE place so the live preview and the committed value never diverge. */
export function resizeItem(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberId: string,
  w: number,
  h: number,
): GroupGraph {
  return patchItem(graph, parentRef, memberId, {
    w: Math.max(MIN_ITEM_W, Math.round(w)),
    h: Math.max(MIN_ITEM_H, Math.round(h)),
  });
}

/** Edit an item's text/content (note typing, caption). */
export function editItem(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberId: string,
  patch: { text?: string; src?: string; [key: string]: unknown },
): GroupGraph {
  return patchItem(graph, parentRef, memberId, patch);
}

/** Merge a presentation patch onto one item (the one generic item mutation). */
export function patchItem(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberId: string,
  patch: Record<string, unknown>,
): GroupGraph {
  const current = (getGroup(graph, parentRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, parentRef, memberId, { presentation: pruneUndefined({ ...current, ...patch }) });
}

/**
 * BATCH presentation patch — the O(M+K) sibling of {@link patchItem}. A batch layout op
 * (align / distribute / arrange / pack) patches K members of one group at once; folding K x
 * `patchItem` re-spreads the WHOLE members map on every single patch — O(K*M), which on a
 * select-all (K = M = N) is O(N^2) and freezes the commit path on a large imported board. This
 * rebuilds the members map ONCE (one O(M) spread + K in-place merges) and re-homes the group ONCE,
 * so a K-patch batch is O(M+K). Every UNTOUCHED member keeps its reference identity (structural
 * sharing, P1); only the K patched members get a new object.
 *
 * SEMANTICS: identical to `patches.reduce((g, {memberId, patch}) => patchItem(g, parentRef, memberId,
 * patch), graph)` for every member present in the group — same per-member presentation merge + prune,
 * same final graph shape (mirrors the leaf `withGroup` + `setMemberFields`). The one intentional
 * divergence: a patch naming a member ABSENT from the group is SKIPPED, not thrown (a batch's patches
 * always derive from current items, so this never fires — but a stale id can no longer abort the whole
 * batch, which is strictly safer). `group-board-model` already reads `.members[id].presentation` in
 * `patchItem`, so constructing the batch graph here adds no coupling the model does not already carry.
 * Pure graph -> graph; a zero-effect batch returns the SAME graph reference.
 */
export function patchItems(
  graph: GroupGraph,
  parentRef: AddressRef,
  patches: ReadonlyArray<{ memberId: string; patch: Record<string, unknown> }>,
): GroupGraph {
  const group = getGroup(graph, parentRef);
  if (!group || patches.length === 0) return graph;
  const nextMembers = { ...group.members }; // ONE O(M) spread for the whole batch (not per-patch)
  let changed = false;
  for (const { memberId, patch } of patches) {
    const cur = nextMembers[memberId];
    if (!cur) continue; // stale id (never in a real batch) — skip, do not abort the batch
    const curPres = (cur.presentation ?? {}) as Record<string, unknown>;
    nextMembers[memberId] = pruneUndefined({
      memberId: cur.memberId,
      nodeRef: cur.nodeRef,
      role: cur.role,
      presentation: pruneUndefined({ ...curPres, ...patch }),
    });
    changed = true;
  }
  if (!changed) return graph; // no patch matched a live member — identical graph reference
  return { groups: { ...graph.groups, [groupKey(group.groupRef)]: { ...group, members: nextMembers } } };
}

/** Remove an item from the board. */
export function removeItem(graph: GroupGraph, parentRef: AddressRef, memberId: string): GroupGraph {
  return removeMember(graph, parentRef, memberId);
}

/**
 * BATCH item removal — the O(M+K) sibling of {@link removeItem} (completes the batch trio with
 * {@link patchItems} + {@link placeItems}). Deleting a large selection folds `removeItem` per id, and each
 * `removeItem -> removeMember` does `{ ...group.members }` + a `memberOrder.filter` — O(M) PER id, so
 * deleting K of M members is O(K*M) = O(N^2) and freezes the commit path. This spreads the members map
 * ONCE (K deletes) and filters `memberOrder` ONCE -> O(M+K). Ids absent from the group are ignored
 * (removeMember is itself a no-op for them). Every surviving member keeps its reference identity
 * (structural sharing, P1). Semantically identical to `memberIds.reduce((g, id) => removeItem(g, parentRef,
 * id), graph)`. Pure; a no-op batch (empty / all-absent) returns the SAME graph reference.
 */
export function removeItems(graph: GroupGraph, parentRef: AddressRef, memberIds: readonly string[]): GroupGraph {
  if (memberIds.length === 0) return graph;
  const group = getGroup(graph, parentRef);
  if (!group) return graph;
  const remove = new Set(memberIds);
  let anyPresent = false;
  for (const id of remove) {
    if (id in group.members) {
      anyPresent = true;
      break;
    }
  }
  if (!anyPresent) return graph; // nothing to delete → identical graph reference
  const nextMembers = { ...group.members }; // ONE O(M) spread for the whole batch (not O(M) per id)
  for (const id of remove) delete nextMembers[id]; // O(K) deletes
  return {
    groups: {
      ...graph.groups,
      [groupKey(parentRef)]: {
        groupRef: group.groupRef,
        memberOrder: group.memberOrder.filter((id) => !remove.has(id)), // ONE O(M) filter (Set lookup O(1))
        members: nextMembers,
      },
    },
  };
}

/**
 * Set a group's member paint order to `order` in ONE pass — the batch primitive
 * behind every z-order restack (bring-to-front, send-to-back, Objects-panel
 * drag-reorder). The old path folded the leaf `reorderMember` (each an O(M)
 * memberOrder filter + rebuild) once per moved id → O(K*M) = O(N^2) on a
 * select-all restack or a full-board drag-reorder. This rebuilds memberOrder
 * exactly ONCE: the given ids (that still exist, de-duped, in the given order)
 * followed by any current members `order` omitted, kept in their existing
 * relative order. For the real caller contract — `order` is a permutation of the
 * group's current members — the result is `order` verbatim; the omitted-append
 * tail only guards a partial/foreign `order` so one stale id never drops members
 * (skip-not-throw, matching the other batch primitives). The `members` MAP is
 * returned by reference — only `memberOrder` (an id-array) changes, so every
 * member node keeps pointer identity (P1 structural sharing).
 */
export function setMemberOrder(graph: GroupGraph, parentRef: AddressRef, order: readonly string[]): GroupGraph {
  const group = getGroup(graph, parentRef);
  if (!group) return graph;
  const seen = new Set<string>();
  const nextOrder: string[] = [];
  for (const id of order) {
    if (id in group.members && !seen.has(id)) {
      seen.add(id);
      nextOrder.push(id);
    }
  }
  // Append any current member the caller's order left out, in current order, so a
  // partial order can never silently delete members from the paint list.
  for (const id of group.memberOrder) {
    if (!seen.has(id)) nextOrder.push(id);
  }
  // No-op restack (order unchanged) → return the SAME graph reference so a
  // bring-to-front on an already-front selection emits no spurious delta. The old
  // reorderMember fold always allocated a fresh group even when nothing moved.
  const cur = group.memberOrder;
  if (nextOrder.length === cur.length && nextOrder.every((id, i) => id === cur[i])) return graph;
  return {
    groups: {
      ...graph.groups,
      [groupKey(parentRef)]: {
        groupRef: group.groupRef,
        memberOrder: nextOrder,
        members: group.members, // unchanged → reference-preserved (only order moved)
      },
    },
  };
}

/**
 * Wrap N selected items into a nested section (infinite nesting — leaf I2).
 * The leaf does the cycle-safe, order-preserving membership surgery; this only
 * supplies the board's SECTION presentation (kind/position/label) as opaque data.
 * `sectionNodeRef` is the new group's ref; `wrapperMemberId` is its member id in
 * the parent. Returns the graph unchanged if fewer than 2 members are selected.
 */
export function groupItems(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  args: {
    sectionNodeRef: AddressRef;
    wrapperMemberId: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    text?: string;
  },
): GroupGraph {
  if (memberIds.length < 2) return graph;
  return groupMembers(graph, parentRef, memberIds, args.sectionNodeRef, {
    wrapperMemberId: args.wrapperMemberId,
    presentation: pruneUndefined({
      kind: 'section',
      x: args.x,
      y: args.y,
      w: args.w ?? DEFAULTS.w,
      h: args.h ?? DEFAULTS.h,
      text: args.text ?? 'Section',
    }),
  });
}

/** Dissolve a section back into its parent (children rejoin the parent in place). */
export function ungroupItems(graph: GroupGraph, parentRef: AddressRef, wrapperMemberId: string): GroupGraph {
  return ungroupMembers(graph, parentRef, wrapperMemberId);
}

/**
 * Move an item from its current group INTO another group (drag-and-drop onto a
 * section). The leaf preserves the member's identity/nodeRef/presentation and
 * refuses cycles (a section can't be dropped into its own descendant) — we treat
 * a refused move as a no-op so a bad drop never corrupts the board.
 */
export function moveItemToGroup(
  graph: GroupGraph,
  fromRef: AddressRef,
  toGroupRef: AddressRef,
  memberId: string,
): GroupGraph {
  try {
    return moveMember(graph, memberId, { fromGroupRef: fromRef, toGroupRef });
  } catch {
    return graph;
  }
}

/**
 * BATCH cross-group move — the O(M_from + M_to + K) sibling of {@link moveItemToGroup} (the 5th and last
 * batch primitive, alongside {@link patchItems}/{@link placeItems}/{@link removeItems}). "Move the selection
 * out to the parent" (and any bulk move of K members from ONE group to ANOTHER) folds `moveItemToGroup`, and
 * each `moveItemToGroup -> moveMember` does `removeMember` (O(M_from)) + `addMember` (O(M_to)) — so moving K
 * members was O(K*(M_from+M_to)) = O(N^2). This removes the K from the source in ONE pass and appends them to
 * the dest in ONE pass -> O(M_from + M_to + K); untouched members in BOTH groups keep reference identity
 * (structural sharing, P1). Each moved member carries its own nodeRef/role/presentation unchanged.
 *
 * CROSS-GROUP only (`fromRef != toRef` — the move-selection-out / move-into-section use). Matching
 * `moveItemToGroup`'s try/catch-to-no-op, an id is SKIPPED when it is absent from the source, a DUPLICATE
 * already in the dest, or a CYCLE (its subtree already contains the dest). Same-group (`fromRef == toRef`) is
 * a no-op here (bulk same-group reorder is a different op the caller never triggers). Semantically identical
 * to `memberIds.reduce((g, id) => moveItemToGroup(g, fromRef, toGroupRef, id), graph)` for the cross-group
 * case. Pure; a no-op batch returns the SAME graph reference.
 */
export function moveItemsToGroup(
  graph: GroupGraph,
  fromRef: AddressRef,
  toGroupRef: AddressRef,
  memberIds: readonly string[],
): GroupGraph {
  if (memberIds.length === 0 || groupKey(fromRef) === groupKey(toGroupRef)) return graph;
  const fromGroup = getGroup(graph, fromRef);
  const toGroup = getGroup(graph, toGroupRef);
  if (!fromGroup || !toGroup) return graph;
  const toMembers = { ...toGroup.members }; // ONE spread of the dest members
  const movedIds: string[] = [];
  const removeSet = new Set<string>();
  for (const id of memberIds) {
    if (removeSet.has(id)) continue; // repeated id in the batch — move once
    const member = fromGroup.members[id];
    if (!member) continue; // absent from source → skip (moveMember would throw → moveItemToGroup no-ops)
    if (id in toMembers) continue; // duplicate already in dest → skip (addMember would throw)
    if (reaches(graph, member.nodeRef, toGroupRef)) continue; // cycle → skip (its subtree contains the dest)
    toMembers[id] = member; // carries its own nodeRef/role/presentation
    movedIds.push(id);
    removeSet.add(id);
  }
  if (movedIds.length === 0) return graph; // nothing moved → identical graph reference
  const fromMembers = { ...fromGroup.members }; // ONE spread of the source members
  for (const id of removeSet) delete fromMembers[id];
  return {
    groups: {
      ...graph.groups,
      [groupKey(fromRef)]: {
        groupRef: fromGroup.groupRef,
        memberOrder: fromGroup.memberOrder.filter((id) => !removeSet.has(id)), // ONE filter
        members: fromMembers,
      },
      [groupKey(toGroupRef)]: {
        groupRef: toGroup.groupRef,
        memberOrder: [...toGroup.memberOrder, ...movedIds], // append the moved ids in order
        members: toMembers,
      },
    },
  };
}

/**
 * Place an EMPTY section (a folder) on the canvas — the folders-first path: make
 * the folder, drill in, then add items (the panel routes Add into the open group).
 * The section's own group is ensured empty so it persists with childCount 0 (the
 * EEAF upserts any group present in the graph, even with no members).
 */
export function placeSection(
  graph: GroupGraph,
  parentRef: AddressRef,
  args: {
    memberId: string;
    sectionNodeRef: AddressRef;
    x: number;
    y: number;
    w?: number;
    h?: number;
    text?: string;
    /** Any other section presentation (frame border/aspect/caption, #169/#176/#177/#198),
     *  spread verbatim like `placeItem`'s `extra` so a section carries styling through BOTH
     *  the template applier and the board deep-copy (`boardToTemplate` → `materializeItems`).
     *  `kind` stays authoritative as 'section'; a faithful reader keeps core keys out of `extra`. */
    extra?: Record<string, unknown>;
  },
): GroupGraph {
  const withParent = ensureGroup(graph, parentRef);
  const withSection = ensureGroup(withParent, args.sectionNodeRef);
  // Core fields are AUTHORITATIVE, exactly as in `placeItem`: spread `extra` UNDER the core so an
  // untrusted section (an imported template / shared capsule / stored collection carrying
  // `extra: { kind: 'note', x: 999 }`) can NEVER flip `kind:'section'` or corrupt the geometry.
  // Previously `extra` was spread LAST and won — a section-shape parser only checks `extra` is a
  // plain object, so hostile core-named keys inside it silently overrode the real section fields.
  const core = pruneUndefined({
    kind: 'section',
    x: args.x,
    y: args.y,
    w: args.w ?? DEFAULTS.w,
    h: args.h ?? DEFAULTS.h,
    text: args.text ?? 'Section',
  });
  return addMember(withSection, parentRef, args.sectionNodeRef, {
    memberId: args.memberId,
    presentation: pruneUndefined({ ...(args.extra ?? {}), ...core }),
  });
}

/** True iff a board (root group) has zero members — drives the empty state. */
export function isBoardEmpty(graph: GroupGraph, ref: AddressRef): boolean {
  const group = getGroup(graph, ref);
  return !group || group.memberOrder.length === 0;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Deep-copy every member of one board's root group into another board's root,
 * preserving NESTED SECTIONS (recursively — a section is itself a group, I2) and
 * REMAPPING connector endpoints + every node address to the destination board.
 *
 * Why two passes: a connector member carries `presentation.fromMemberId` /
 * `toMemberId` that reference OTHER members BY ID. A copy that mints fresh ids must
 * know the FULL old→new id map BEFORE it places any connector, or the connector
 * would point at the source board's ids (a dangling edge). Pass 1 maps every member
 * id across the whole tree; pass 2 places + remaps.
 *
 * Pure: `mint` supplies fresh unique ids (member ids AND item/section node ids), so
 * the function is deterministic under test and has no `newId()` side effect inside.
 * The SOURCE board is never mutated (only the destination groups are written).
 */
export function copyBoardContents(
  graph: GroupGraph,
  srcBoardId: string,
  destBoardId: string,
  mint: () => string,
): GroupGraph {
  // Read the source board into DATA descriptors, then run the ONE SSOT deep-copy engine
  // (`materializeItems`) that the template applier also uses — connector remap, section
  // nesting, and styled-frame fidelity now live in exactly one place (L030/L063).
  return materializeItems(
    graph,
    destBoardId,
    boardRootRef(destBoardId),
    boardToTemplate(graph, srcBoardId),
    mint,
  );
}

/**
 * Read a board's live contents into `TemplateItem[]` DATA — the inverse of
 * `materializeItems`/`placeInto`. Each member becomes a descriptor carrying its FULL
 * presentation: core keys (kind/x/y/w/h/text) as fields, connector endpoints as
 * `from`/`to` (by the SOURCE member id, remapped when re-materialized), a nested
 * section's members as `children` (recursion), and EVERYTHING else (src,
 * visualLayerStack, frame border/aspect/caption, …) verbatim in `extra`. Pure reader —
 * the graph is never mutated. This is the bridge that lets a live board flow through
 * the same deep-copy engine as a catalog template.
 */
export function boardToTemplate(graph: GroupGraph, srcBoardId: string): TemplateItem[] {
  const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const walk = (groupRef: AddressRef): TemplateItem[] =>
    membersOf(graph, groupRef).map((m) => {
      const { kind, x, y, w, h, text, fromMemberId, toMemberId, ...rest } = {
        ...(m.presentation ?? {}),
      } as Record<string, unknown>;
      const nested = getGroup(graph, m.nodeRef);
      const item: {
        id: string;
        kind: string;
        x: number;
        y: number;
        w: number;
        h: number;
        text?: string;
        extra?: Record<string, unknown>;
        from?: string;
        to?: string;
        children?: TemplateItem[];
      } = {
        id: m.memberId,
        kind: typeof kind === 'string' ? kind : nested ? 'section' : 'note',
        x: numOr(x, 0),
        y: numOr(y, 0),
        w: numOr(w, DEFAULTS.w),
        h: numOr(h, DEFAULTS.h),
      };
      if (typeof text === 'string') item.text = text;
      if (Object.keys(rest).length > 0) item.extra = rest;
      if (typeof fromMemberId === 'string') item.from = fromMemberId;
      if (typeof toMemberId === 'string') item.to = toMemberId;
      if (nested) item.children = walk(m.nodeRef); // nested section → recurse
      return item as TemplateItem;
    });
  return walk(boardRootRef(srcBoardId));
}

/**
 * Duplicate a whole board: register a new board (entry + empty root), deep-copy the
 * source board's contents into it (see {@link copyBoardContents}), and carry the
 * source board's chosen background. Returns the new graph; the caller switches to
 * `newBoardId`. `mint` supplies fresh ids for the copied members/nodes.
 */
/**
 * Carry a board's LOOK profile (background + grid-snap + the #225 appearance-defaults
 * cascade) from a source entry onto a destination index member. The ONE place
 * board-level look travels on a copy — a new board-level look key is one line HERE,
 * never a fresh `if` at every copy site (L063). NOT identity/state (`title`,
 * `archived`, cadence) — a copy gets its own of those.
 */
export function carryBoardLook(
  graph: GroupGraph,
  indexRef: AddressRef,
  src: BoardEntry | undefined,
  destMemberId: string,
): GroupGraph {
  if (!src) return graph;
  let next = graph;
  if (src.background) next = setBoardBackground(next, indexRef, destMemberId, src.background);
  if (src.gridSnap) next = setBoardGridSnap(next, indexRef, destMemberId, true);
  if (src.appearance && Object.keys(src.appearance).length > 0) {
    next = applyAppearanceProfileToBoard(next, indexRef, destMemberId, src.appearance);
  }
  return next;
}

export function duplicateBoard(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { srcBoardId: string; newBoardId: string; newMemberId: string; title: string; mint: () => string },
): GroupGraph {
  let next = addBoard(graph, indexRef, {
    memberId: args.newMemberId,
    boardId: args.newBoardId,
    title: args.title,
  });
  next = copyBoardContents(next, args.srcBoardId, args.newBoardId, args.mint);
  // Carry the WHOLE look profile (background + gridSnap + #225 appearance), not just
  // background — duplicating a board previously silently dropped its appearance defaults.
  const srcEntry = readBoards(graph, indexRef).find((b) => b.boardId === args.srcBoardId);
  next = carryBoardLook(next, indexRef, srcEntry, args.newMemberId);
  return next;
}
