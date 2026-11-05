// packages/group/read-data/share-capsule.ts
//
// The OUTPUT of a share: scope → capsule → link. This is the piece that was missing —
// `resolveShareScope` said WHICH items, `ShareScopeControl` picked the scope, but nothing
// turned that into a shareable thing. A `ShareCapsule` is a self-contained, serialization-
// safe snapshot of the scoped content of ONE OR MORE boards, plus a link codec.
//
// Why self-contained (the link CONTAINS the content): a preview/local share must work with
// ZERO hosting — the anti-primitive rule says external hosting/DNS may block PUBLIC
// production but never blocks local/preview proof or UI wiring. So `encodeShareLink`
// produces a link whose fragment carries the whole capsule; `decodeShareLink` reconstructs
// it with no network. The PUBLIC hosted short-link is the `public-scene-share` owner's job
// (group hands it this exact capsule via Envelope) — no god package, no capsule minting here.
//
// Multi-board falls out for free (L069): a capsule holds N boards, so "share several boards
// with one link" is just `buildShareCapsule` over N sources — the collection-basket composes
// straight into it.
//
// Pure & deterministic: no I/O, no Date.now/Math.random. The capsule id is a content hash,
// so identical scoped content always yields the same link (idempotent shares). Runs
// unchanged in the browser and under vitest (uses only encode/decodeURIComponent + string).

import {
  DEFAULT_SCOPE_RESOLVERS,
  resolveShareScope,
  type ScopeItem,
  type ScopeResolver,
  type ShareScopeRequest,
} from './share-scope.ts';
import { finiteCoord, BOARD_COORD_LIMIT } from './finite-coord.ts';

// ---- untrusted-decode DoS bounds (a capsule arrives inside a pasted/opened LINK) ----------
// These are GUARDS, not feature caps: no legitimate share approaches them, but a hostile link
// can carry an arbitrarily large JSON payload. Each bound lets `decodeShareLink` fail-closed
// (→ "not a capsule", null) BEFORE it burns CPU/memory on a pathological input.
const MAX_LINK_LEN = 8_000_000; // ~8MB of URL text — reject before regex/decode/JSON.parse
const MAX_CAPSULE_BOARDS = 1_000; // a multi-board share of thousands of boards is abuse
const MAX_CAPSULE_ITEMS = 100_000; // total items across ALL boards (bounds `.every` + the map)
const MAX_STRINGIFY_DEPTH = 64; // extra-object nesting the content hash will walk (deep JSON DoS)

/** The minimal renderable projection of a board item — serialization-safe (no AddressRef,
 *  no functions). The opener reconstructs a full BoardItem from this. */
export interface PortableItem {
  readonly memberId: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text?: string;
  readonly html?: string;
  readonly src?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  /** True iff this item is a nested SECTION (a drill-in folder). The opener renders it as a
   *  labeled folder box; its children ride in the SAME flat list at their world coords (the
   *  board's own export-flattening model — board-tree.ts). */
  readonly isSection?: boolean;
  /** How many items live inside a section — drives the folder's count badge. */
  readonly childCount?: number;
}

/** One board's worth of shared content inside a capsule. */
export interface CapsuleBoard {
  readonly boardId: string;
  readonly title: string;
  readonly items: readonly PortableItem[];
  /** The board's surface-look catalog id (board-backgrounds), so the opened board looks
   *  like the original. Absent → the default surface. */
  readonly background?: string;
}

/** A portable, self-contained share. `v` guards forward compatibility of the link codec. */
export interface ShareCapsule {
  readonly v: 1;
  readonly id: string; // deterministic content hash (stable link identity)
  readonly name: string;
  readonly boards: readonly CapsuleBoard[];
}

/** A renderable + scopeable item: everything the scope resolvers and the opener both need. */
export type CapsuleSourceItem = PortableItem & ScopeItem;

/** One source board: its full item set + the scope to carve out of it. */
export interface CapsuleSource {
  readonly boardId: string;
  readonly title: string;
  readonly items: readonly CapsuleSourceItem[];
  readonly scope: ShareScopeRequest;
  /** The board's surface-look catalog id, carried into the capsule for fidelity. */
  readonly background?: string;
}

// ---- capsule construction ---------------------------------------------------

function portableOf(it: CapsuleSourceItem): PortableItem {
  const out: {
    -readonly [K in keyof PortableItem]: PortableItem[K];
  } = { memberId: it.memberId, kind: it.kind, x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.text !== undefined) out.text = it.text;
  if (it.html !== undefined) out.html = it.html;
  if (it.src !== undefined) out.src = it.src;
  if (it.extra !== undefined) out.extra = it.extra;
  if (it.isSection !== undefined) out.isSection = it.isSection;
  if (it.childCount !== undefined) out.childCount = it.childCount;
  return out;
}

/** Build a capsule from N source boards, applying each board's scope. Boards that end up
 *  empty after scoping are dropped (an empty board is not shareable content). The scope
 *  resolver map is injected — a new scope kind never touches this function. */
export function buildShareCapsule(
  sources: readonly CapsuleSource[],
  name: string,
  resolvers: Readonly<Record<string, ScopeResolver>> = DEFAULT_SCOPE_RESOLVERS,
): ShareCapsule {
  const boards: CapsuleBoard[] = [];
  for (const src of sources) {
    // FAIL CLOSED on a CORRUPT board. The keep-set + section/connector closures + the final filter all
    // key on `memberId`, which is only group-LOCAL — the flattened board assumes it is board-UNIQUE.
    // Normal minting makes it so, but a crafted/corrupted board (duplicate ids across sections) breaks
    // the assumption: a SUBSET scope (section/tag/type/selection) resolves the id of ONE item and the
    // filter would then keep EVERY same-id item → an out-of-scope item leaks into the share. A whole
    // 'board' scope shares everything regardless (no subset ambiguity), so it stays safe. Refuse to emit
    // a subset of an id-ambiguous board rather than risk over-sharing. No-op for every real board.
    if (src.scope.kind !== 'board') {
      const ids = src.items.map((it) => it.memberId);
      if (new Set(ids).size !== ids.length) continue; // duplicate memberIds + subset scope → share nothing
    }
    // An item's `kind` IS its type — surface it as `itemKind` for the 'type' scope so
    // callers never set the same concept twice (kind already carries it).
    const scopeInput = src.items.map((it) => ({ ...it, itemKind: it.itemKind ?? it.kind }));
    const keep = new Set(resolveShareScope(scopeInput, src.scope, resolvers));
    // Section closure (L063 — one rule): a kept SECTION brings its WHOLE subtree, so sharing a
    // board (or a selected section) carries the nested content, never an empty folder. Items carry
    // `sectionId` = their enclosing section's id; transitive so nested-in-nested sections come too.
    // For 'board' scope keep already holds everything → no-op (zero regression).
    for (let grew = true; grew; ) {
      grew = false;
      for (const it of src.items) {
        const parent = it.sectionId;
        if (parent !== undefined && keep.has(parent) && !keep.has(it.memberId)) {
          keep.add(it.memberId);
          grew = true;
        }
      }
    }
    // Connector closure (L063 — one rule for every subset scope): a connector whose BOTH
    // endpoints are kept comes along, so sharing "these cards" preserves the relationships
    // between them — not just for the whole board. A connector is self-describing
    // (extra.fromMemberId/toMemberId); this never adds a node, so 'board' scope is unchanged.
    for (const it of src.items) {
      const ex = it.extra as { fromMemberId?: unknown; toMemberId?: unknown } | undefined;
      const from = ex?.fromMemberId;
      const to = ex?.toMemberId;
      if (typeof from === 'string' && typeof to === 'string' && keep.has(from) && keep.has(to)) {
        keep.add(it.memberId);
      }
    }
    // Prune a DANGLING connector from the export: a connector directly selected (or otherwise kept) whose
    // endpoints are NOT both kept would ride into the capsule as a line to nothing. Drop it so the exported
    // capsule holds no dangling edge — symmetric with the import-side drop in relationship-graph (cont.96).
    for (const it of src.items) {
      const ex = it.extra as { fromMemberId?: unknown; toMemberId?: unknown } | undefined;
      const from = ex?.fromMemberId;
      const to = ex?.toMemberId;
      if (typeof from === 'string' && typeof to === 'string' && keep.has(it.memberId) && !(keep.has(from) && keep.has(to))) {
        keep.delete(it.memberId);
      }
    }
    const items = src.items.filter((it) => keep.has(it.memberId)).map(portableOf);
    if (items.length === 0) continue;
    boards.push({
      boardId: src.boardId,
      title: src.title,
      items,
      ...(src.background !== undefined ? { background: src.background } : {}),
    });
  }
  const body = { v: 1 as const, name, boards };
  return { ...body, id: hashCapsule(body) };
}

/** Human-readable summary of what a capsule shares (for the copied-link toast). */
export function capsuleSummary(capsule: ShareCapsule): string {
  const boardCount = capsule.boards.length;
  const itemCount = capsule.boards.reduce((n, b) => n + b.items.length, 0);
  const boards = boardCount === 1 ? '1 board' : `${boardCount} boards`;
  const items = itemCount === 1 ? '1 item' : `${itemCount} items`;
  return `${items} across ${boards}`;
}

// ---- link codec (self-contained, environment-agnostic) ----------------------

const CAPSULE_PARAM = 'capsule';
const REFERENCE_FORMAT = 'group-shared-content-references';
const CONTENT_FIELDS = ['text', 'html', 'src', 'extra'] as const;
type PortableContent = Pick<PortableItem, typeof CONTENT_FIELDS[number]>;

/** References are local to this exact handoff, never permission to fetch another
 * record. Keep one copy of each distinct body across all included boards. The
 * existing viewer still receives the same validated static capsule after decode. */
function referencedShare(capsule: ShareCapsule) {
  const contents: PortableContent[] = [];
  const byBody = new Map<string, number>();
  const boards = capsule.boards.map((board) => ({
    ...board,
    items: board.items.map((item) => {
      const { text, html, src, extra, ...placement } = item;
      const body = { text, html, src, extra };
      // Exact serialized bytes are the equality key, not the short display id or
      // the depth-limited capsule hash. Different bodies cannot alias on a hash.
      const key = JSON.stringify(body);
      let contentRef = byBody.get(key);
      if (contentRef === undefined) {
        contentRef = contents.length;
        contents.push(body);
        byBody.set(key, contentRef);
      }
      return { ...placement, contentRef };
    }),
  }));
  // Do not label the wire as the inline format: an older reader would otherwise
  // accept reference-only placements and silently display empty cards.
  return { format: REFERENCE_FORMAT, id: capsule.id, name: capsule.name, boards, contents };
}

function expandSharedReferences(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const wire = value as Record<string, unknown>;
  if (wire.format !== REFERENCE_FORMAT) return value;
  if (wire.v !== undefined || !Array.isArray(wire.contents) || wire.contents.length > MAX_CAPSULE_ITEMS
    || !Array.isArray(wire.boards) || wire.boards.length > MAX_CAPSULE_BOARDS) return null;
  const serializedContents: string[] = [];
  for (const body of wire.contents) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !CONTENT_FIELDS.includes(key as typeof CONTENT_FIELDS[number]))) return null;
    serializedContents.push(JSON.stringify(body));
  }
  const used = new Set<number>();
  let count = 0;
  let expandedLength = 0;
  const boards = [];
  for (const raw of wire.boards) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.items)) return null;
    count += raw.items.length;
    if (count > MAX_CAPSULE_ITEMS) return null;
    const items = [];
    for (const entry of raw.items) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const { contentRef, ...placement } = entry;
      if (!Number.isSafeInteger(contentRef) || contentRef < 0 || contentRef >= wire.contents.length
        || CONTENT_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(placement, key))) return null;
      // A small link must not expand one large body into gigabytes of content.
      expandedLength += serializedContents[contentRef].length + JSON.stringify(placement).length;
      if (expandedLength > MAX_LINK_LEN) return null;
      used.add(contentRef);
      // References compact the handoff, not mutable editor state. Give each
      // placement its own decoded body so editing one cannot change another.
      items.push({ ...placement, ...JSON.parse(serializedContents[contentRef]) });
    }
    boards.push({ ...raw, items });
  }
  // Unused bodies can smuggle content outside the actual shared selection.
  if (used.size !== wire.contents.length) return null;
  return { v: 1, id: wire.id, name: wire.name, boards };
}
// Global so `matchAll` (last-marker-wins on decode) and `replace` (strip existing markers on
// encode) both work. matchAll clones the regex internally and replace resets lastIndex, so
// reusing this module const across calls carries no shared-state hazard.
const CAPSULE_RE_G = /[#&?]capsule=([^&]*)/gi;

/** Encode a capsule into a self-contained link. The whole capsule rides in the URL
 *  fragment (never sent to a server) as URI-encoded JSON — unicode-safe, no base64, works
 *  in node + browser. `base` is the opener URL (e.g. the board app origin+path). */
export function encodeShareLink(capsule: ShareCapsule, base = ''): string {
  // Strip any existing capsule marker(s) from `base` so a re-encode (or a base that already
  // carries a capsule) never leaves TWO markers — the decoder would otherwise resolve one of them
  // ambiguously. A trailing separator left behind is trimmed so the appended marker is clean.
  const clean = base.replace(CAPSULE_RE_G, '').replace(/[#&?]+$/, '');
  return `${clean}#${CAPSULE_PARAM}=${encodeURIComponent(JSON.stringify(referencedShare(capsule)))}`;
}

/** Sanitize a decoded capsule at the ONE trust boundary. Two defenses, both fail-closed:
 *
 *  1. LIVE-MOUNT strip — a capsule is STATIC content opened with ZERO hosting, so it must never
 *     carry a LIVE-MOUNT directive. `extra.placeableSurface` mounts a running package surface
 *     (PlaceableSurfaceHost) through the SAME shared renderer the read-only viewer uses, so an
 *     untrusted link could smuggle an arbitrary package mount (attacker-chosen packageName/
 *     entryName/surfaceInput) into a recipient's viewer — a capability breach (SP7). Stripped from
 *     every item; the rest of the board still opens as static content (fail-closed to safe render).
 *  2. COORD clamp — `isPortableItem` only proves x/y/w/h are FINITE, but `Number.MAX_VALUE` is
 *     finite yet overflows to ±Infinity in the opener's `x+w`/midpoint/SVG-path math. Clamp every
 *     coord through the `finiteCoord` SSOT (±BOARD_COORD_LIMIT), and floor w/h at 0 (a negative
 *     dimension is never a real item). No-op for any real board coordinate. */
function withoutLiveMounts(capsule: ShareCapsule): ShareCapsule {
  return {
    ...capsule,
    boards: capsule.boards.map((b) => ({
      ...b,
      items: b.items.map((it) => {
        const cx = finiteCoord(it.x), cy = finiteCoord(it.y);
        const cw = Math.max(0, finiteCoord(it.w)), ch = Math.max(0, finiteCoord(it.h));
        const clamped = (cx !== it.x || cy !== it.y || cw !== it.w || ch !== it.h)
          ? { ...it, x: cx, y: cy, w: cw, h: ch }
          : it;
        if (!clamped.extra || !('placeableSurface' in clamped.extra)) return clamped;
        const safe = { ...clamped.extra };
        delete (safe as Record<string, unknown>).placeableSurface;
        return { ...clamped, extra: safe };
      }),
    })),
  };
}

/** Reconstruct a capsule from a link (or a bare fragment). Returns null on anything that
 *  is not a valid capsule — never throws. */
export function decodeShareLink(link: string): ShareCapsule | null {
  // Reject an absurdly long link BEFORE the regex scan / decode / JSON.parse (a hostile paste can
  // be arbitrarily large; no legitimate capsule link approaches 8MB). Fail-closed = "not a capsule".
  if (link.length > MAX_LINK_LEN) return null;
  // LAST marker wins — the freshest append (what encodeShareLink just added) is the intended
  // capsule, so a stray earlier `#capsule=` in the base can never shadow it.
  const matches = [...link.matchAll(CAPSULE_RE_G)];
  if (matches.length === 0) return null;
  try {
    const obj = expandSharedReferences(JSON.parse(decodeURIComponent(matches[matches.length - 1][1])));
    return isShareCapsule(obj) ? withoutLiveMounts(obj) : null;
  } catch {
    return null;
  }
}

/** True iff `href` carries a decodable share capsule — the opener route uses this to decide
 *  whether to show a shared board instead of the normal app. */
export function hasCapsuleLink(href: string): boolean {
  return decodeShareLink(href) !== null;
}

/** A capsule item is UNTRUSTED (it arrives inside a share LINK). The opener + importer both do
 *  `item.x`, `item.w`, … directly, so a non-object item or a non-numeric coord would crash the
 *  board the moment the link is opened/pasted. This is the ONE trust boundary — validate the
 *  full PortableItem shape here so everything downstream can trust it (L098 boundary-owns-
 *  validation; SP5 fail-closed: a malformed link decodes to null = "not a capsule", never a crash). */
function isPortableItem(x: unknown): x is PortableItem {
  if (typeof x !== 'object' || x === null) return false;
  const i = x as Record<string, unknown>;
  // Required geometry + identity: the opener does `item.x`, `item.w`, … directly.
  if (
    typeof i.memberId !== 'string' ||
    typeof i.kind !== 'string' ||
    typeof i.x !== 'number' || !Number.isFinite(i.x) ||
    typeof i.y !== 'number' || !Number.isFinite(i.y) ||
    typeof i.w !== 'number' || !Number.isFinite(i.w) ||
    typeof i.h !== 'number' || !Number.isFinite(i.h)
  ) {
    return false;
  }
  // The content fields must be the RIGHT TYPE when present — a hostile link that sets
  // `text`/`html`/`src` to a non-string or `extra` to a non-object is rejected outright, so the
  // renderer never receives a wrong-typed value (the html is additionally sanitized at the
  // opener). Fail-closed at the one declared trust boundary (SP5/L098).
  if (i.text !== undefined && typeof i.text !== 'string') return false;
  if (i.html !== undefined && typeof i.html !== 'string') return false;
  if (i.src !== undefined && typeof i.src !== 'string') return false;
  if (i.extra !== undefined && (typeof i.extra !== 'object' || i.extra === null)) return false;
  if (i.isSection !== undefined && typeof i.isSection !== 'boolean') return false;
  if (i.childCount !== undefined && (typeof i.childCount !== 'number' || !Number.isFinite(i.childCount))) return false;
  return true;
}

export function isShareCapsule(x: unknown): x is ShareCapsule {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  if (c.v !== 1 || typeof c.id !== 'string' || typeof c.name !== 'string') return false;
  if (!Array.isArray(c.boards)) return false;
  if (c.boards.length > MAX_CAPSULE_BOARDS) return false; // DoS guard: a share of >1000 boards is abuse
  // Track the RUNNING total across boards so a hostile link can't smuggle 100k+ items — `.every`
  // short-circuits false the moment the budget is blown, before the expensive per-item validation
  // continues (bounds both this pass and the later `withoutLiveMounts` map).
  let itemTotal = 0;
  return c.boards.every((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const board = b as Record<string, unknown>;
    if (typeof board.boardId !== 'string' || typeof board.title !== 'string' || !Array.isArray(board.items)) return false;
    itemTotal += board.items.length;
    if (itemTotal > MAX_CAPSULE_ITEMS) return false; // total-item DoS guard (fail-closed)
    return board.items.every(isPortableItem); // every item well-formed → downstream can trust coords
  });
}

// ---- deterministic content hash ---------------------------------------------

/** Stable JSON: object keys emitted in sorted order at every depth, so the same content
 *  always hashes identically regardless of key insertion order (important for `extra`). */
function stableStringify(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  // DEPTH CAP: `extra` is UNTRUSTED once a decoded capsule has been imported + persisted — sharing
  // that board later feeds its deep `extra` back through here. Uncapped recursion stack-overflows on
  // pathologically nested input. Beyond the cap we emit a sentinel: the hash stays deterministic
  // (identical deep content → identical sentinel) and never crashes. No real `extra` nests this deep.
  if (depth > MAX_STRINGIFY_DEPTH) return '"__deep__"';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  // Drop keys whose value is `undefined` — native `JSON.stringify` (what encodeShareLink uses to
  // serialize the link) omits them, so the hash MUST omit them too, else `{foo:undefined}` and
  // `{}` hash differently yet encode identically, breaking the "same content → same link" claim.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`).join(',')}}`;
}

/** FNV-1a 32-bit over the stable JSON → base-36 id. Deterministic, dependency-free. */
function hashCapsule(body: Omit<ShareCapsule, 'id'>): string {
  const json = stableStringify(body);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
