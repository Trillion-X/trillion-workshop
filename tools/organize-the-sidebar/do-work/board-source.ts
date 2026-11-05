// parts/group/do-work/board-source.ts
//
// PURPOSE
//   Any set of records drawn on the board, kept in step with where they come from. A source says what its records
//   are (cards: words, a live state, a group) and how they connect (lines, each saying what flows along it); the board
//   places a card per record and a connector per line, lays new ones out in layers left to right (in one frame per
//   group when there are more than a handful), and on every later read changes only what changed: new records are
//   placed, gone records leave, words and states follow their record. A workflow's steps, a run lighting up, the
//   automations that start each other, messages split into tasks: each is one source drawn on the same board, with
//   the board's drawing, shapes, notes, pictures, connectors, frames, collapse and tidy around it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: a source is cards and lines; nothing here names a kind of record, a screen or a product.
//   2. The record is the truth for its words and state; the board is the truth for where its card sits. A card the
//      person moved, resized or recoloured stays as they left it; only `text`, `extra.sourceState` and
//      `extra.sourceActions` follow the record.
//   3. Only cards and connectors this source placed (their `extra.source.key` is the source's key) are ever changed
//      or removed; everything the person drew, wrote or placed is never touched.
//   4. Recompute from truth: the same source read twice plans nothing the second time.
//   5. A card's own words edited on the board come back as `sourceEdits` (record id and new words) so the source's
//      owner can keep them; the board never decides what an edit means for the record.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { BoardItem, PlaceItemArgs } from '../read-data/group-board-model.ts';
import { itemRef } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';

/** A record's live state as a card shows it: its words and a tone (good, attention, bad, info, quiet or a badge variant). */
export type SourceState = { readonly label: string; readonly tone?: string; readonly pulse?: boolean };
/** Something the person can do to the record from its card (try again, ask my AI): the source decides what it does. */
export type SourceAction = { readonly id: string; readonly label: string };
export type SourceCard = { readonly id: string; readonly text: string; readonly state?: SourceState | null; readonly actions?: readonly SourceAction[] | null; readonly group?: string | null };
/** A line between two records: what flows along it (`label`) and what kind of thing it carries (`kind`, any word the
 *  source chooses), which picks its colour and the port it leaves from and arrives at. */
export type SourceLine = { readonly from: string; readonly to: string; readonly label?: string | null; readonly kind?: string | null };
export type BoardSource = { readonly key: string; readonly cards: readonly SourceCard[]; readonly lines: readonly SourceLine[] };

export type SourceLayout = {
  /** Where the first new card goes. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly card: { readonly w: number; readonly h: number };
  readonly gap: { readonly x: number; readonly y: number };
  /** More cards than this, and cards that name groups, are laid out in one frame per group. */
  readonly most: number;
  /** Room inside a frame around its cards, and above them for its name. */
  readonly framePadding: number;
  /** The colour a line of each kind is drawn in (any kind word → a colour); kinds not named take `palette` in turn. */
  readonly kinds?: Readonly<Record<string, string>>;
  readonly palette?: readonly string[];
  /** How a source's lines are routed (any routing the board knows, such as curved). */
  readonly routing?: string;
};

/** A dot on a card's edge where lines of one kind leave (right) or arrive (left). */
export type SourcePort = { readonly side: 'left' | 'right'; readonly at: number; readonly color?: string; readonly title?: string };

/** The colour of a line kind: named in the layout, else the next palette colour in order of first appearance. */
function colourOfKind(layout: SourceLayout, kinds: readonly string[]): Map<string, string> {
  const colours = new Map<string, string>();
  let next = 0;
  for (const kind of kinds) {
    if (colours.has(kind)) continue;
    const named = layout.kinds?.[kind];
    const palette = layout.palette ?? [];
    colours.set(kind, named ?? (palette.length ? palette[next++ % palette.length] : ''));
  }
  return colours;
}

/** Each card's ports (one per kind leaving it on the right, one per kind arriving on the left) and where each line
 *  attaches, so lines of one kind share a port and never cross another kind's. */
function portsOf(lines: readonly SourceLine[], colours: Map<string, string>) {
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, kind: string) => { const list = map.get(id) ?? []; if (!list.includes(kind)) list.push(kind); map.set(id, list); };
  for (const line of lines) { add(out, line.from, line.kind ?? ''); add(into, line.to, line.kind ?? ''); }
  const at = (list: readonly string[], kind: string) => (list.indexOf(kind) + 1) / (list.length + 1);
  const portsFor = (id: string): SourcePort[] => [
    ...(into.get(id) ?? []).map(kind => ({ side: 'left' as const, at: at(into.get(id)!, kind), ...(colours.get(kind) ? { color: colours.get(kind) } : {}), ...(kind ? { title: kind } : {}) })),
    ...(out.get(id) ?? []).map(kind => ({ side: 'right' as const, at: at(out.get(id)!, kind), ...(colours.get(kind) ? { color: colours.get(kind) } : {}), ...(kind ? { title: kind } : {}) })),
  ];
  const anchorsFor = (line: SourceLine) => ({
    fromAnchor: { nx: 1, ny: at(out.get(line.from) ?? [], line.kind ?? '') },
    toAnchor: { nx: 0, ny: at(into.get(line.to) ?? [], line.kind ?? '') },
  });
  return { portsFor, anchorsFor };
}

/** The ports a source card shows, as the board draws them. */
export function sourcePortsOf(item: BoardItem): SourcePort[] {
  const ports = item.extra?.sourcePorts;
  return Array.isArray(ports) ? ports.filter((port): port is SourcePort => (port?.side === 'left' || port?.side === 'right') && typeof port?.at === 'number') : [];
}

export type SourcePlan = {
  readonly place: PlaceItemArgs[];
  readonly patch: { memberId: string; patch: Record<string, unknown> }[];
  readonly remove: string[];
};

type SourceMark = { key: string; id: string; role: 'card' | 'line' | 'group' };

/** The source a board item belongs to, if a source placed it. */
export function sourceMarkOf(item: BoardItem): SourceMark | null {
  const mark = item.extra?.source as Partial<SourceMark> | undefined;
  return mark && typeof mark.key === 'string' && typeof mark.id === 'string' && (mark.role === 'card' || mark.role === 'line' || mark.role === 'group')
    ? { key: mark.key, id: mark.id, role: mark.role } : null;
}

/** Member ids are the source's key and the record's id, so the same record always lands on the same card. */
const memberIdOf = (key: string, role: SourceMark['role'], id: string) => `src:${key}:${role}:${id}`;
const sameState = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Layers left to right: each card one column after the furthest card leading into it (cycles fall back to order). */
function layersOf(cards: readonly SourceCard[], lines: readonly SourceLine[]): Map<string, number> {
  const ids = new Set(cards.map(card => card.id));
  const into = new Map<string, string[]>();
  for (const line of lines) if (ids.has(line.from) && ids.has(line.to) && line.from !== line.to) into.set(line.to, [...(into.get(line.to) ?? []), line.from]);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(into.get(id) ?? []).map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const card of cards) depth(card.id);
  return layer;
}

/** Where each card goes inside a box starting at (x, y): layered columns, rows within a column in source order. */
function layOut(cards: readonly SourceCard[], lines: readonly SourceLine[], at: { x: number; y: number }, layout: SourceLayout) {
  const layer = layersOf(cards, lines);
  const rowIn = new Map<number, number>();
  const spot = new Map<string, { x: number; y: number }>();
  for (const card of cards) {
    const column = layer.get(card.id) ?? 0;
    const row = rowIn.get(column) ?? 0;
    rowIn.set(column, row + 1);
    spot.set(card.id, { x: at.x + column * (layout.card.w + layout.gap.x), y: at.y + row * (layout.card.h + layout.gap.y) });
  }
  const columns = Math.max(0, ...layer.values()) + 1;
  const rows = Math.max(1, ...rowIn.values());
  return { spot, w: columns * layout.card.w + (columns - 1) * layout.gap.x, h: rows * layout.card.h + (rows - 1) * layout.gap.y };
}

/**
 * What the board must change so it shows `source` (invariants 2–4): cards and connectors to place for new records and
 * lines, patches for words and states that changed, and the source's own items whose record or line is gone. `placed`
 * says where records the person just added from the board should land (record id → board point).
 */
export function planBoardSource(items: readonly BoardItem[], source: BoardSource, boardId: string, layout: SourceLayout, placed?: ReadonlyMap<string, { x: number; y: number }>): SourcePlan {
  const mine = new Map<string, BoardItem>();
  for (const item of items) {
    const mark = sourceMarkOf(item);
    if (mark?.key === source.key) mine.set(item.memberId, item);
  }
  const place: PlaceItemArgs[] = [];
  const patch: SourcePlan['patch'] = [];
  const keep = new Set<string>();
  const mark = (role: SourceMark['role'], id: string): SourceMark => ({ key: source.key, id, role });

  // New cards go below everything already on the board, so they never land on the person's work.
  const others = items.filter(item => !mine.has(item.memberId) && !itemIsConnector(item));
  const below = others.length ? Math.max(...others.map(item => item.y + item.h)) + layout.gap.y * 2 : layout.origin.y;
  const fresh = source.cards.filter(card => !mine.has(memberIdOf(source.key, 'card', card.id)));
  const groups = new Map<string, SourceCard[]>();
  for (const card of fresh) groups.set(card.group ?? '', [...(groups.get(card.group ?? '') ?? []), card]);
  const framed = source.cards.length > layout.most && groups.size > 1;
  const spots = new Map<string, { x: number; y: number }>();
  if (framed) {
    let y = below;
    for (const [group, cards] of groups) {
      const pad = layout.framePadding;
      const laid = layOut(cards, source.lines, { x: layout.origin.x + pad, y: y + pad * 2 }, layout);
      for (const [id, at] of laid.spot) spots.set(id, at);
      const frameId = memberIdOf(source.key, 'group', group || '-');
      keep.add(frameId);
      if (!mine.has(frameId)) {
        place.push({ memberId: frameId, nodeRef: itemRef(boardId, frameId), kind: 'frame', x: layout.origin.x, y, w: laid.w + pad * 2, h: laid.h + pad * 3, text: group,
          extra: { presentationFrame: { order: place.length + 1 }, source: mark('group', group || '-') } });
      }
      y += laid.h + pad * 3 + layout.gap.y * 2;
    }
  } else {
    for (const [id, at] of layOut(fresh, source.lines, { x: layout.origin.x, y: below }, layout).spot) spots.set(id, at);
  }
  for (const frameId of mine.keys()) if (mine.get(frameId)!.extra?.source && sourceMarkOf(mine.get(frameId)!)?.role === 'group') keep.add(frameId);

  const cardIds = new Set(source.cards.map(card => card.id));
  const lines = source.lines.filter(line => cardIds.has(line.from) && cardIds.has(line.to) && line.from !== line.to);
  const colours = colourOfKind(layout, lines.map(line => line.kind ?? ''));
  const { portsFor, anchorsFor } = portsOf(lines, colours);
  const portsOrNone = (id: string) => { const ports = portsFor(id); return ports.length ? ports : null; };

  for (const card of source.cards) {
    const memberId = memberIdOf(source.key, 'card', card.id);
    const ports = portsOrNone(card.id);
    keep.add(memberId);
    const kept = mine.get(memberId);
    if (kept) {
      const changes: Record<string, unknown> = {};
      if ((kept.text ?? '') !== card.text) changes.text = card.text;
      if (!sameState(kept.extra?.sourceState, card.state)) changes.sourceState = card.state ?? undefined;
      if (!sameState(kept.extra?.sourceActions, card.actions?.length ? card.actions : null)) changes.sourceActions = card.actions?.length ? card.actions : undefined;
      if (!sameState(kept.extra?.sourcePorts, ports)) changes.sourcePorts = ports ?? undefined;
      if (Object.keys(changes).length) patch.push({ memberId, patch: changes });
      continue;
    }
    // A record the person just added lands centred where they asked for it; any other new record takes its layer.
    const asked = placed?.get(card.id);
    const at = asked ? { x: asked.x - layout.card.w / 2, y: asked.y - layout.card.h / 2 } : spots.get(card.id) ?? layout.origin;
    place.push({ memberId, nodeRef: itemRef(boardId, memberId), kind: 'note', x: at.x, y: at.y, w: layout.card.w, h: layout.card.h, text: card.text,
      extra: { source: mark('card', card.id), ...(card.state ? { sourceState: card.state } : {}), ...(card.actions?.length ? { sourceActions: card.actions } : {}), ...(ports ? { sourcePorts: ports } : {}) } });
  }
  for (const line of lines) {
    const lineId = line.kind ? `${line.from}>${line.to}:${line.kind}` : `${line.from}>${line.to}`;
    const memberId = memberIdOf(source.key, 'line', lineId);
    if (keep.has(memberId)) continue;
    keep.add(memberId);
    const kept = mine.get(memberId);
    const label = line.label ?? undefined;
    const color = colours.get(line.kind ?? '') || undefined;
    const { fromAnchor, toAnchor } = anchorsFor(line);
    if (kept) {
      const changes: Record<string, unknown> = {};
      if ((kept.extra?.label ?? undefined) !== label) changes.label = label;
      if (!sameState(kept.extra?.fromAnchor, fromAnchor)) changes.fromAnchor = fromAnchor;
      if (!sameState(kept.extra?.toAnchor, toAnchor)) changes.toAnchor = toAnchor;
      if (Object.keys(changes).length) patch.push({ memberId, patch: changes });
      continue;
    }
    place.push({ memberId, nodeRef: itemRef(boardId, memberId), kind: 'connector', x: 0, y: 0, w: 0, h: 0,
      extra: { fromMemberId: memberIdOf(source.key, 'card', line.from), toMemberId: memberIdOf(source.key, 'card', line.to), fromAnchor, toAnchor,
        ...(label ? { label } : {}), ...(color ? { color } : {}), ...(layout.routing ? { routing: layout.routing } : {}), ...(line.kind ? { lineKind: line.kind } : {}), source: mark('line', lineId) } });
  }
  const remove = [...mine.keys()].filter(memberId => !keep.has(memberId));
  return { place, patch, remove };
}

/** The source's cards whose words the person changed on the board between two reads (invariant 5). */
export function sourceEdits(before: readonly BoardItem[], after: readonly BoardItem[], key: string): { id: string; text: string }[] {
  const was = new Map(before.map(item => [item.memberId, item.text ?? '']));
  return after.flatMap(item => {
    const mark = sourceMarkOf(item);
    if (mark?.key !== key || mark.role !== 'card' || !was.has(item.memberId)) return [];
    const text = item.text ?? '';
    return text !== was.get(item.memberId) && text.trim() ? [{ id: mark.id, text }] : [];
  });
}

/** The actions a source card offers, as the board shows them. */
export function sourceActionsOf(item: BoardItem): SourceAction[] {
  const actions = item.extra?.sourceActions;
  return Array.isArray(actions) ? actions.filter((action): action is SourceAction => typeof action?.id === 'string' && typeof action?.label === 'string') : [];
}
