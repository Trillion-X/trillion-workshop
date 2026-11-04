// packages/group/show/board-layer-rows.ts
//
// The pure model for the Objects/Layers panel — a TREE (#153, superseding the
// flat #151 list). Board items form a tree: a SECTION is a member that is itself
// a group with its own members (arbitrary nesting). The panel mirrors that tree,
// TOP-MOST z first at every level (Figma/Miro canon). Items arrive in render/z
// order (last renders on top), so each level's list is the reverse.
//
// Kept pure + framework-free so ordering, label derivation, and nesting are unit
// testable without a DOM. The children of a section are resolved through an
// INJECTED `childrenOf` resolver (DI — same shape as the export `fillOf` and the
// board-copy `mint`), so this model never imports the live graph and the engine
// stays blind to what a "section" stores. The panel is a blind renderer of these
// nodes.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsLocked } from '../read-data/group-board-model';

/** A row kind names only how to LABEL/icon the row — derived from the item's data
 *  shape (section flag / image src / else note), never a stored Society string.
 *  The blind renderer never reads `.kind` (see the #151 L090-nuance memory). */
export type BoardLayerKind = 'section' | 'image' | 'note';

/** The per-row fields shared by flat and tree shapes. */
export interface BoardLayerRow {
  /** The member id — the universal handle the panel selects/toggles by. */
  id: string;
  /** Human label: the item's text (collapsed + truncated) else a kind fallback. */
  label: string;
  kind: BoardLayerKind;
  hidden: boolean;
  locked: boolean;
  selected: boolean;
}

/** A tree node = a row plus its expand state and (for sections) its children,
 *  top-most z first. Children are ALWAYS populated for a section (so the panel
 *  knows whether to show an expand chevron); the panel renders them only when
 *  `expanded` — collapse is a pure render concern, never a model omission. */
export interface BoardLayerNode extends BoardLayerRow {
  expanded: boolean;
  children: BoardLayerNode[];
}

const MAX_LABEL = 40;

function rowKind(it: BoardItem): BoardLayerKind {
  if (it.isSection) return 'section';
  if (typeof it.src === 'string' && it.src.length > 0) return 'image';
  return 'note';
}

function rowLabel(it: BoardItem, kind: BoardLayerKind): string {
  const text = (it.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
  return kind === 'section' ? 'Section' : kind === 'image' ? 'Image' : 'Note';
}

function rowFields(it: BoardItem, kind: BoardLayerKind, selectedIds: ReadonlySet<string>): BoardLayerRow {
  return {
    id: it.memberId,
    label: rowLabel(it, kind),
    kind,
    // hidden/locked are per-item DATA flags (`extra.hidden`/`extra.locked`) read
    // straight off the item, so a NESTED child reflects its own state — top-level
    // id-sets only know the board root. Selection is a board-wide flat set.
    hidden: it.extra?.hidden === true,
    locked: itemIsLocked(it),
    selected: selectedIds.has(it.memberId),
  };
}

/**
 * Map placed board items to an Objects-panel TREE, TOP-MOST z first at every
 * level. `topItems` are the board's top-level connector-free members; `childrenOf`
 * resolves a section item's connector-free children (the caller reads the live
 * graph and filters connectors). Recurses into every section to arbitrary depth.
 */
export function boardLayerTree(
  topItems: readonly BoardItem[],
  childrenOf: (item: BoardItem) => readonly BoardItem[],
  selectedIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
): BoardLayerNode[] {
  const walk = (items: readonly BoardItem[]): BoardLayerNode[] => {
    const nodes = items.map((it): BoardLayerNode => {
      const kind = rowKind(it);
      const children = kind === 'section' ? walk(childrenOf(it)) : [];
      return {
        ...rowFields(it, kind, selectedIds),
        expanded: expandedIds.has(it.memberId),
        children,
      };
    });
    nodes.reverse(); // render order is bottom→top; the panel shows top→bottom
    return nodes;
  };
  return walk(topItems);
}
