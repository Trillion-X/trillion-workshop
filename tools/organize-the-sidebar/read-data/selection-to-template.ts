// packages/group/read-data/selection-to-template.ts
//
// Turn a board selection into a BoardTemplate (the SSOT portable-stack model that
// applyTemplate + TemplatesGallery already consume). Ports the normalization that the
// retired collection-from-selection leaf owned (keep selected in item-order, min-x/y ->
// (0,0), drop connectors with an unkept endpoint) but emits BoardTemplate items directly:
// each kept item -> a TemplateItem; each surviving connector -> a `kind:'connector'`
// TemplateItem whose `from`/`to` are the SELECTED memberIds (applyTemplate remaps those
// template-local ids to freshly minted member ids on apply). Pure, deterministic — no
// Date.now / Math.random / I/O.

import type { BoardTemplate, TemplateItem } from './board-template-apply.ts';
import { finiteCoord } from './finite-coord.ts';
import { ownValue } from './facet-filter.ts';

/** Sanitize a persisted item dimension (w/h) into a finite, non-negative board coord. */
const fdim = (v: number): number => Math.max(0, finiteCoord(v));
/** Read an own `fromMemberId`/`toMemberId` string endpoint off an item's `extra` — own-key only, so an
 *  INHERITED endpoint (ambient/custom prototype) can't misclassify a plain item as a connector (#7). */
const ownEndpoint = (extra: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined => {
  const v = extra ? ownValue(extra, key) : undefined;
  return typeof v === 'string' ? v : undefined;
};

/** The template connector contract is `from`/`to` (template-local ids, remapped on apply). The
 *  LIVE-board connector shape (`extra.fromMemberId`/`toMemberId`) must NOT ride along in a stored
 *  template — those are stale source member ids, redundant with `from`/`to` and overwritten on
 *  apply. Strip them so a stored/merged template is self-consistent (Codex R5 correction). */
function stripLiveEndpointKeys(
  extra: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!extra || (ownEndpoint(extra, 'fromMemberId') === undefined && ownEndpoint(extra, 'toMemberId') === undefined)) return extra;
  const { fromMemberId: _f, toMemberId: _t, ...rest } = extra as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** A live board item offered to selectionToTemplate (the shape a selection provides). */
export interface CollectionSourceItem {
  readonly memberId: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text?: string;
  readonly html?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A live connector offered to selectionToTemplate (endpoints are live memberIds). */
export interface CollectionSourceConnector {
  readonly memberId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Build a BoardTemplate from a selection.
 *
 * - Kept items: those whose memberId is in `selectedIds`, in the ORDER of `items`
 *   (not of `selectedIds`). None kept -> `{ id: id ?? name, name, items: [] }`.
 * - Positions normalized: the min x/y over kept items maps to (0,0).
 * - Each kept item -> a TemplateItem `{ id: memberId, kind, x-minX, y-minY, w, h, text?, extra? }`.
 *   TemplateItem has no `html` field, so a present `html` is folded into `extra`
 *   (`{ ...extra, html }`) rather than lost.
 * - Each connector whose BOTH endpoints are kept -> a TemplateItem
 *   `{ id: memberId, kind:'connector', x:0,y:0,w:0,h:0, from: fromId, to: toId, extra? }`.
 *   Connectors referencing an unkept endpoint are dropped.
 */
export function selectionToTemplate(
  items: readonly CollectionSourceItem[],
  connectors: readonly CollectionSourceConnector[],
  selectedIds: readonly string[],
  name: string,
  id?: string,
): BoardTemplate {
  const templateId = id ?? name;
  const selected = new Set(selectedIds);

  // Keep selected items in the order of `items`.
  const kept = items.filter((item) => selected.has(item.memberId));

  if (kept.length === 0) {
    return { id: templateId, name, items: [] };
  }

  // Normalize so the bundle's top-left corner sits at (0,0). Read every source coord through finiteCoord:
  // a persisted NaN would poison minX/minY (`NaN < minX` is false → the min never updates, then every
  // `x - minX` is NaN), and a Number.MAX_VALUE would propagate into normalized coords + section sizes (#4).
  let minX = finiteCoord(kept[0].x);
  let minY = finiteCoord(kept[0].y);
  for (const item of kept) {
    const ix = finiteCoord(item.x), iy = finiteCoord(item.y);
    if (ix < minX) minX = ix;
    if (iy < minY) minY = iy;
  }

  const keptIds = new Set<string>(kept.map((item) => item.memberId));

  const itemTemplates: TemplateItem[] = kept.map((item) => {
    // TemplateItem has no `html`; fold a present html into extra so it isn't lost.
    const extra: Record<string, unknown> | undefined =
      item.html !== undefined ? { ...(item.extra ?? {}), html: item.html } : item.extra;
    const t: {
      id: string;
      kind: string;
      x: number;
      y: number;
      w: number;
      h: number;
      text?: string;
      extra?: Readonly<Record<string, unknown>>;
    } = {
      id: item.memberId,
      kind: item.kind,
      x: finiteCoord(item.x) - minX,
      y: finiteCoord(item.y) - minY,
      w: fdim(item.w),
      h: fdim(item.h),
    };
    if (item.text !== undefined) t.text = item.text;
    if (extra !== undefined) t.extra = extra;
    return t;
  });

  const connectorTemplates: TemplateItem[] = [];
  for (const connector of connectors) {
    if (!keptIds.has(connector.fromId) || !keptIds.has(connector.toId)) {
      continue; // one or both endpoints not kept -> drop
    }
    const t: {
      id: string;
      kind: string;
      x: number;
      y: number;
      w: number;
      h: number;
      from: string;
      to: string;
      extra?: Readonly<Record<string, unknown>>;
    } = {
      id: connector.memberId,
      kind: 'connector',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from: connector.fromId,
      to: connector.toId,
    };
    const cleanExtra = stripLiveEndpointKeys(connector.extra);
    if (cleanExtra !== undefined) t.extra = cleanExtra;
    connectorTemplates.push(t);
  }

  return { id: templateId, name, items: [...itemTemplates, ...connectorTemplates] };
}

/** A connector is any item carrying BOTH `extra.fromMemberId` and `extra.toMemberId` (the
 *  canonical shape predicate, L090 — never a `kind === 'connector'` string). Local to keep
 *  this leaf free of a group-board-model import. */
function isConnectorSource(i: CollectionSourceItem): boolean {
  return ownEndpoint(i.extra, 'fromMemberId') !== undefined && ownEndpoint(i.extra, 'toMemberId') !== undefined;
}

/**
 * Build a collection {@link BoardTemplate} from a FLAT board item list (items AND connectors
 * mixed, as `readItems` returns them) + the selected ids. Partitions by the shape predicate
 * above, maps connector members to `{fromId,toId}` endpoints, and delegates to
 * {@link selectionToTemplate}. This is the ONE place the panel's "save the selection"
 * extraction lives — pure and testable without a live panel (R5). Deterministic, no I/O.
 */
export function boardSelectionToTemplate(
  allItems: readonly CollectionSourceItem[],
  selectedIds: readonly string[],
  name: string,
  id?: string,
): BoardTemplate {
  const items = allItems.filter((i) => !isConnectorSource(i));
  const connectors: CollectionSourceConnector[] = allItems.filter(isConnectorSource).map((c) => ({
    memberId: c.memberId,
    fromId: ownEndpoint(c.extra, 'fromMemberId')!, // own-key (isConnectorSource already proved both present)
    toId: ownEndpoint(c.extra, 'toMemberId')!,
    extra: c.extra,
  }));
  return selectionToTemplate(items, connectors, selectedIds, name, id);
}

/** One board's contribution to a merged collection: the board's flat items + the ids selected
 *  ON that board. `label` is an optional provenance name (for section-wrapping / display);
 *  `boardId` is the optional source-board id (for provenance / distinct-board counts). */
export interface CollectionPick {
  readonly allItems: readonly CollectionSourceItem[];
  readonly selectedIds: readonly string[];
  readonly label?: string;
  readonly boardId?: string;
}

/** The bottom edge of a sub-template's content (max y+h over non-connector items; connectors are
 *  position-less). Items are already normalized to min-y = 0, so this is the block's height. */
function subTemplateHeight(items: readonly TemplateItem[]): number {
  let bottom = 0;
  for (const it of items) {
    if (it.kind === 'connector') continue;
    const b = it.y + it.h;
    if (b > bottom) bottom = b;
  }
  return bottom;
}

/** Prefix a template item's id (and connector endpoints, with the SAME prefix so within-board
 *  connectors stay intact) and shift it by (dx, dy). Recurses into section children — renaming
 *  their ids/endpoints but NOT re-shifting them (children share the top-level coordinate space,
 *  so they get the SAME shift, applied once per node). Connectors are position-less (x/y stay 0).
 *  Pure. */
function namespaceAndShift(it: TemplateItem, prefix: string, dx: number, dy: number): TemplateItem {
  const isConnector = it.kind === 'connector';
  const out: {
    id: string; kind: string; x: number; y: number; w: number; h: number;
    text?: string; extra?: Readonly<Record<string, unknown>>;
    children?: readonly TemplateItem[]; from?: string; to?: string;
  } = {
    id: prefix + it.id,
    kind: it.kind,
    x: isConnector ? it.x : it.x + dx,
    y: isConnector ? it.y : it.y + dy,
    w: it.w,
    h: it.h,
  };
  if (it.text !== undefined) out.text = it.text;
  if (it.extra !== undefined) out.extra = it.extra;
  if (it.from !== undefined) out.from = prefix + it.from;
  if (it.to !== undefined) out.to = prefix + it.to;
  // Section children share the same absolute coordinate space (materializeItems places them at
  // their own x/y), so they take the SAME (dx,dy) shift as the section — applied once per node.
  if (it.children !== undefined) out.children = it.children.map((c) => namespaceAndShift(c, prefix, dx, dy));
  return out;
}

/** The right edge of a sub-template's content (max x+w over non-connector items). */
function subTemplateWidth(items: readonly TemplateItem[]): number {
  let right = 0;
  for (const it of items) {
    if (it.kind === 'connector') continue;
    const r = it.x + it.w;
    if (r > right) right = r;
  }
  return right;
}

/**
 * Merge selections from MANY boards into ONE collection (R5 — a user: "pull in from all these
 * other boards and throw all these different things in here into one template together"). Each
 * {@link CollectionPick} is one board's items + the ids selected on it; this reuses
 * {@link boardSelectionToTemplate} per pick (SSOT — the N=1 case), NAMESPACES each pick's ids +
 * connector endpoints with a per-pick `s<i>:` prefix so the same memberId on two boards never
 * collides, and STACKS the picks vertically (each below the previous by its height + `gap`) so
 * the merged boards don't overlap. Within-board connectors survive (from/to get the same
 * prefix); there are no cross-board connectors (endpoints live on different boards). Empty picks
 * are skipped; all-empty → an honest empty template. Pure, deterministic — no Date.now/random/IO.
 *
 * `opts.sectionsByLabel` (emergent, Codex-endorsed): when set AND a pick carries a `label`, that
 * pick's items are wrapped in a labelled SECTION (the generic `children` primitive) so the merged
 * collection keeps each source board's provenance as a titled group. Padding leaves room for the
 * section title. Picks without a label fall back to the flat stack in the same run.
 */
export function mergeSelectionsToCollection(
  picks: readonly CollectionPick[],
  name: string,
  id?: string,
  opts?: { gap?: number; sectionsByLabel?: boolean },
): BoardTemplate {
  const gap = typeof opts?.gap === 'number' ? Math.max(0, finiteCoord(opts.gap)) : 80; // clamp: seeds offsetY accumulation
  const PAD = 24; // inner padding around a provenance section's contents
  const HEADER = 48; // room at the top of a section for its title
  const templateId = id ?? name;
  const merged: TemplateItem[] = [];
  let offsetY = 0;
  picks.forEach((pick, idx) => {
    const sub = boardSelectionToTemplate(pick.allItems, pick.selectedIds, name, templateId);
    if (sub.items.length === 0) return; // nothing selected on this board — skip
    const prefix = `s${idx}:`;
    const wrap = opts?.sectionsByLabel === true && !!pick.label;
    if (wrap) {
      // Section wrapper at (0, offsetY); children shifted to sit inside it, below the title.
      const subW = subTemplateWidth(sub.items);
      const subH = subTemplateHeight(sub.items);
      const children = sub.items.map((it) => namespaceAndShift(it, prefix, PAD, offsetY + HEADER));
      merged.push({
        id: `${prefix}source`,
        kind: 'section',
        x: 0,
        y: offsetY,
        w: subW + PAD * 2,
        h: subH + HEADER + PAD,
        text: pick.label,
        children,
      });
      offsetY += subH + HEADER + PAD + gap;
    } else {
      for (const it of sub.items) merged.push(namespaceAndShift(it, prefix, 0, offsetY));
      offsetY += subTemplateHeight(sub.items) + gap;
    }
  });
  return { id: templateId, name, items: merged };
}
