// packages/group/show/selection-actions.ts
//
// The DATA-DRIVEN selection ACTION LIST — the product model that surfaces the selection LEAVES (b184–b187) as a
// real menu. Each modality (geometry `itemsInRect`, connectivity `growSelection`, attribute `selectMatching`,
// plus basic all/invert/clear) becomes a self-describing `SelectionAction {id, label, section, run, enabled}`.
// The menu component renders this list BLINDLY (L090) — it names no specific action, so a new selection op is a
// new row here (or, for "Select same …", a new BOARD_DIMENSIONS row — ZERO menu code). This is the sibling of
// `selection-capabilities.ts`: that file gates which single-target edits are meaningful; this one is the
// multi-target SELECT operations. Pure fold — no hooks, unit-testable, the god surface shrinks.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { invertSelection } from '../read-data/box-select';
import { buildRelationGraph } from '../read-data/relationship-graph';
import { growSelection, shrinkSelection, relationComponentOf } from '../read-data/selection-grow';
import { selectMatchingByDimension } from '../read-data/select-matching';
import { BOARD_DIMENSIONS } from '../read-data/board-report';

/** One selection operation as DATA: run it on the current items+selection to get the NEW selection. `enabled`
 *  gates a dead no-op row out of the menu (L118) — a row only shows when it would actually change something. */
export interface SelectionAction {
  readonly id: string;
  readonly label: string;
  readonly section: string; // display grouping (a menu heading) — presentation DATA, names no engine concept
  run(items: readonly BoardItem[], selectedIds: readonly string[]): string[];
  enabled(items: readonly BoardItem[], selectedIds: readonly string[]): boolean;
}

const hasSelection = (_items: readonly BoardItem[], sel: readonly string[]): boolean => sel.length > 0;
const boardHasConnectors = (items: readonly BoardItem[]): boolean => items.some(itemIsConnector);
/** ≥1 seed carries a value for the dimension (so "Select same <dim>" would return a non-empty set). */
function seedsHaveDimensionValue(items: readonly BoardItem[], sel: readonly string[], dimensionKey: string): boolean {
  const def = BOARD_DIMENSIONS.find((d) => d.key === dimensionKey);
  if (!def) return false;
  const facet = def.extract(items);
  const seedSet = new Set(sel);
  return items.some((i) => seedSet.has(i.memberId) && facet(i).length > 0);
}

/**
 * The full selection-action catalog as DATA. Basic (all/invert/clear), Expand over the relation graph (grow one
 * hop / shrink one hop / select the whole connected component — gated on the board actually having connectors),
 * and one "Select same <dimension>" per `BOARD_DIMENSIONS` row (tag/colour/kind/cluster/progress-band — so the
 * attribute selectors are generated from the SAME catalog the reducers use, never hand-listed). The menu renders
 * `enabledSelectionActions`, so a new dimension = a new "Select same …" row with zero menu edits.
 */
export const SELECTION_ACTIONS: readonly SelectionAction[] = [
  { id: 'all', label: 'Select all', section: 'Basic', enabled: (items) => items.length > 0, run: (items) => items.map((i) => i.memberId) },
  { id: 'invert', label: 'Invert selection', section: 'Basic', enabled: hasSelection, run: (items, sel) => invertSelection(items, sel) },
  { id: 'clear', label: 'Clear selection', section: 'Basic', enabled: hasSelection, run: () => [] },
  { id: 'grow', label: 'Grow selection', section: 'Expand', enabled: (items, sel) => hasSelection(items, sel) && boardHasConnectors(items), run: (items, sel) => growSelection(buildRelationGraph(items), sel, 1) },
  { id: 'shrink', label: 'Shrink selection', section: 'Expand', enabled: (items, sel) => hasSelection(items, sel) && boardHasConnectors(items), run: (items, sel) => shrinkSelection(buildRelationGraph(items), sel) },
  { id: 'connected', label: 'Select connected', section: 'Expand', enabled: (items, sel) => hasSelection(items, sel) && boardHasConnectors(items), run: (items, sel) => relationComponentOf(buildRelationGraph(items), sel) },
  ...BOARD_DIMENSIONS.map((d): SelectionAction => ({
    id: `same-${d.key}`,
    label: `Select same ${d.label.toLowerCase()}`,
    section: 'Same attribute',
    enabled: (items, sel) => hasSelection(items, sel) && seedsHaveDimensionValue(items, sel, d.key),
    run: (items, sel) => selectMatchingByDimension(items, sel, d.key),
  })),
];

/** The subset of actions meaningful for the current selection (dead no-op rows hidden, L118). Deterministic. */
export function enabledSelectionActions(items: readonly BoardItem[], selectedIds: readonly string[]): SelectionAction[] {
  return SELECTION_ACTIONS.filter((a) => a.enabled(items, selectedIds));
}
