// packages/documents/do-work/build-table-transaction.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE table primitive — and the proof that the split layout node is truly
// generative (L069): a table is NOT a new backend type. It is a Y-axis split of
// rows, where each row is an X-axis split of cells, and EVERY row carries the
// SAME column fractions so the columns line up. There is no `Table`/`Row`/`Cell`
// kind in the engine — only Containers whose `layout` is layout mode `split` (the exact
// structure the engine already lays out). `/table` is a UI verb; the data is
// nested splits. This honours the mandate's "one scene-node primitive, no
// page/canvas/view/mode backend types."
//
// Column alignment is by CONSTRUCTION: all row-splits share one column-fraction
// vector, so the engine (which lays out each X-split independently from its own
// parts) produces aligned columns with zero cross-row layout code. A column
// resize updates that shared vector across every row (setTableColumnFractions),
// reusing the already-Codex-converged split divider math per row. Add/remove
// row/column keep the table rectangular and the per-row `parts.length ===
// cells.length` invariant intact.
//
// Mobbin anatomy (2026-06-20): Qatalog A1–C3 grid, Dropbox Paper "+ to add
// row/column" + header row, Zoom column menu (insert left/right, delete). See
// CS-065 reference contract.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { CompositionTransaction, ScenePatch, SceneNode } from '../read-data/documents';
import { applySplitDividerDrag, DEFAULT_SPLIT_GAP_PX, type SplitPart } from './build-split-transaction';

/** Default gap between table cells/rows (px) — a thin grid line feel. */
export const DEFAULT_TABLE_GAP_PX = 1;

export type MakeTableNodeOptions = {
  rows: number;
  columns: number;
  /** Fresh unique node id (e.g. `() => 'node:' + crypto.randomUUID()`). */
  makeId: () => string;
  /** Produces one empty cell child (e.g. the surface's blank flow/text node). */
  makeCell: () => SceneNode;
  /** Gap between cells/rows in px. */
  gap?: number;
};

const splitLayout = (axis: 'x' | 'y', gap: number, parts: SplitPart[]): Record<string, unknown> => ({
  style: { layout: { mode: 'split', axis, gap, parts } },
});

const equalParts = (n: number): SplitPart[] => Array.from({ length: Math.max(1, n) }, () => ({ fraction: 1 }));

/**
 * Build a rows×columns table node: a Y-split of row nodes, each an X-split of
 * `columns` empty cells. Every row shares an equal column-fraction vector, so the
 * columns align. INVARIANTS: rows≥1, columns≥1; every row has exactly `columns`
 * cells and `columns` parts.
 */
export function makeTableNode(options: MakeTableNodeOptions): SceneNode {
  const rows = Math.max(1, Math.floor(options.rows));
  const columns = Math.max(1, Math.floor(options.columns));
  const gap = options.gap ?? DEFAULT_TABLE_GAP_PX;
  const makeRow = (): SceneNode => ({
    id: options.makeId(),
    kind: 'Container',
    props: splitLayout('x', gap, equalParts(columns)),
    visible: true,
    children: Array.from({ length: columns }, () => options.makeCell()),
  });
  return {
    id: options.makeId(),
    kind: 'Container',
    props: splitLayout('y', gap, equalParts(rows)),
    visible: true,
    children: Array.from({ length: rows }, () => makeRow()),
  };
}

// ---------------------------------------------------------------------------
// Detection + shape (self-describing structure; no Society marker — L090)
// ---------------------------------------------------------------------------

/** True when a node is a table: a Y-split whose children are all X-splits with equal cell counts. */
export function isTableNode(node: SceneNode | null | undefined): boolean {
  return readTableShape(node) !== null;
}

export type TableShape = {
  rows: number;
  columns: number;
  /** The shared column-fraction vector (read from the first row). */
  columnFractions: number[];
};

/** Decode a table's shape, or null when the node is not a rectangular Y-split-of-X-splits. */
export function readTableShape(node: SceneNode | null | undefined): TableShape | null {
  if (!node) return null;
  const rowsLayout = layoutOf(node);
  if (!isSplitAxis(rowsLayout, 'y')) return null;
  const rows = node.children ?? [];
  if (rows.length === 0) return null;
  let columns = -1;
  for (const row of rows) {
    const rowLayout = layoutOf(row);
    if (!isSplitAxis(rowLayout, 'x')) return null;
    const cellCount = (row.children ?? []).length;
    if (columns === -1) columns = cellCount;
    else if (cellCount !== columns) return null; // ragged → not a table
  }
  if (columns < 1) return null;
  const firstParts = partsOf(rows[0]);
  const columnFractions = firstParts.length === columns ? firstParts.map((p) => p.fraction) : equalParts(columns).map((p) => p.fraction);
  return { rows: rows.length, columns, columnFractions };
}

// ---------------------------------------------------------------------------
// Structural edits (return a NEW table node; pure)
// ---------------------------------------------------------------------------

/**
 * Set the shared column fractions across ALL rows (the result of a column-divider
 * drag). Reuses the split math upstream (the caller passes the new fractions from
 * applySplitDividerDrag); this just fans them out to every row so columns stay
 * aligned. No-op if the count doesn't match the table's column count.
 */
export function setTableColumnFractions(table: SceneNode, columnFractions: number[]): SceneNode {
  const shape = readTableShape(table);
  if (!shape || columnFractions.length !== shape.columns) return table;
  const parts: SplitPart[] = columnFractions.map((fraction) => ({ fraction }));
  return {
    ...table,
    children: (table.children ?? []).map((row) => ({
      ...row,
      props: mergeParts(row.props, parts),
    })),
  };
}

// ---------------------------------------------------------------------------
// Synced column drag → multi-row transaction (the table's L116 verb)
// ---------------------------------------------------------------------------

export type BuildTableColumnDragInput = {
  /** The table node (Y-split whose children are X-split rows). */
  table: SceneNode;
  /** Original column index LEFT of the dragged divider. */
  leftIndex: number;
  /** Original column index RIGHT of the dragged divider (usually leftIndex+1). */
  rightIndex: number;
  /** Pixels the pointer moved along the X (column) axis (right positive). */
  deltaPx: number;
  /**
   * One row's available main-axis width AFTER gaps removed
   * (`splitAvailableMainPx(rowRect, 'x', gap, columns)`). Every row is the same
   * width and shares one column-fraction vector, so a single row's available size
   * is the correct px↔fraction scale for the whole table.
   */
  availableMainPx: number;
  /** Minimum on-screen column width (px). Defaults to applySplitDividerDrag's floor. */
  minColumnPx?: number;
};

/**
 * Turn a column-divider drag into ONE transaction that resizes that column in
 * EVERY row at once — the behaviour that makes a stack of independent splits read
 * as a table. The new shared fractions come from the SAME Codex-converged
 * `applySplitDividerDrag` the per-column split uses (zero new math); we then fan
 * them across all rows as one `UPDATE_PROPS` patch per row. UPDATE_PROPS replaces
 * props wholesale, so each patch spreads that row's existing props/style/layout and
 * overrides only `parts`. Columns stay aligned by construction. Returns an empty
 * transaction when the node is not a table or the drag is a no-op.
 */
export function buildTableColumnDragTransaction(input: BuildTableColumnDragInput): CompositionTransaction {
  const shape = readTableShape(input.table);
  if (!shape) return { scene_patches: [] };
  const parts: SplitPart[] = shape.columnFractions.map((fraction) => ({ fraction }));
  const nextParts = applySplitDividerDrag({
    parts,
    leftIndex: input.leftIndex,
    rightIndex: input.rightIndex,
    deltaPx: input.deltaPx,
    availableMainPx: input.availableMainPx,
    minColumnPx: input.minColumnPx,
  });
  const nextLayoutParts = nextParts.map((p) => ({ fraction: p.fraction }));
  const scene_patches: ScenePatch[] = (input.table.children ?? []).map((row) => {
    const existingProps = isRecord(row.props) ? row.props : {};
    const existingStyle = isRecord(existingProps.style) ? existingProps.style : {};
    const existingLayout = isRecord(existingStyle.layout) ? existingStyle.layout : {};
    return {
      type: 'UPDATE_PROPS',
      node_id: row.id,
      changes: {
        props: {
          ...existingProps,
          style: { ...existingStyle, layout: { ...existingLayout, mode: 'split', parts: nextLayoutParts } },
        },
      },
    };
  });
  return { scene_patches };
}

/** Append a column: one cell + one column-fraction to every row. */
export function addTableColumn(table: SceneNode, makeCell: () => SceneNode): SceneNode {
  const shape = readTableShape(table);
  if (!shape) return table;
  const nextFractions = [...shape.columnFractions, 1];
  return {
    ...table,
    children: (table.children ?? []).map((row) => ({
      ...row,
      props: mergeParts(row.props, nextFractions.map((fraction) => ({ fraction }))),
      children: [...(row.children ?? []), makeCell()],
    })),
  };
}

/** Append a row: a new X-split of `columns` cells carrying the shared column fractions. */
export function addTableRow(table: SceneNode, makeId: () => string, makeCell: () => SceneNode): SceneNode {
  const shape = readTableShape(table);
  if (!shape) return table;
  const gap = gapOf(table.children?.[0]) ?? DEFAULT_TABLE_GAP_PX;
  const newRow: SceneNode = {
    id: makeId(),
    kind: 'Container',
    props: splitLayout('x', gap, shape.columnFractions.map((fraction) => ({ fraction }))),
    visible: true,
    children: Array.from({ length: shape.columns }, () => makeCell()),
  };
  // Preserve existing row heights (the table's own Y-split fractions) and append
  // the new row at weight 1 — SYMMETRIC with addTableColumn, which preserves the
  // column fractions and appends 1. A reset to equalParts would silently discard a
  // user's row-height drags: the table node is itself a Y-split whose dividers the
  // generic split-divider chrome renders, so row heights are user-resizable. Fall
  // back to equal only when the table's parts are desynced from the row count.
  const existingRowParts = partsOf(table);
  const rowParts: SplitPart[] = existingRowParts.length === shape.rows
    ? [...existingRowParts, { fraction: 1 }]
    : equalParts(shape.rows + 1);
  return {
    ...table,
    props: mergeParts(table.props, rowParts),
    children: [...(table.children ?? []), newRow],
  };
}

// ---------------------------------------------------------------------------
// Insert / remove a row or column → granular scene_patches (the wired editor verbs)
//
// Each op emits ONE transaction of granular patches. Column ops touch EVERY row
// (the table shares one column-fraction vector); row ops touch the table node.
// Patches are computed from the PRE-transaction tree: REMOVE_SUBTREE targets a
// node_id (shift-proof), INSERT_NODE an index in an as-yet-unmutated parent — so
// ordering within the batch is safe. The shared-fraction invariant holds because
// every row gets the SAME new parts vector (insert/remove fraction 1 at the index),
// matching addTableColumn/addTableRow (append weight 1, preserve the rest). Remove
// is guarded so a table never drops below 1×1 (readTableShape requires ≥1 each).
// ---------------------------------------------------------------------------

/** Insert a column at `index` (0…columns): one cell + one shared fraction into every row. */
export function buildInsertTableColumnTransaction(input: { table: SceneNode; index: number; makeCell: () => SceneNode }): CompositionTransaction {
  const shape = readTableShape(input.table);
  if (!shape) return { scene_patches: [] };
  const index = clampInsert(input.index, shape.columns);
  const parts = insertAt(shape.columnFractions, index, 1).map((fraction) => ({ fraction }));
  // Canonical patch order (scene_diff_types.rs): ALL structural patches first, then
  // ALL UPDATE_PROPS — the engine applies patches verbatim, no reorder (Codex-converged).
  const structural: ScenePatch[] = [];
  const updates: ScenePatch[] = [];
  for (const row of input.table.children ?? []) {
    structural.push({ type: 'INSERT_NODE', parent_id: row.id, index, node: input.makeCell() });
    updates.push({ type: 'UPDATE_PROPS', node_id: row.id, changes: { props: mergeParts(row.props, parts) } });
  }
  return { scene_patches: [...structural, ...updates] };
}

/** Remove the column at `index`: drop one cell + one fraction from every row. Guard: keep ≥1 column. */
export function buildRemoveTableColumnTransaction(input: { table: SceneNode; index: number }): CompositionTransaction {
  const shape = readTableShape(input.table);
  if (!shape || shape.columns < 2) return { scene_patches: [] };
  const index = clampExisting(input.index, shape.columns);
  const parts = removeAt(shape.columnFractions, index).map((fraction) => ({ fraction }));
  // Canonical order: all REMOVE_SUBTREE first, then all UPDATE_PROPS (Codex-converged).
  const structural: ScenePatch[] = [];
  const updates: ScenePatch[] = [];
  for (const row of input.table.children ?? []) {
    const cell = (row.children ?? [])[index];
    if (cell) structural.push({ type: 'REMOVE_SUBTREE', node_id: cell.id });
    updates.push({ type: 'UPDATE_PROPS', node_id: row.id, changes: { props: mergeParts(row.props, parts) } });
  }
  return { scene_patches: [...structural, ...updates] };
}

/** Insert a row at `index` (0…rows): a new X-split of `columns` cells carrying the shared fractions. */
export function buildInsertTableRowTransaction(input: { table: SceneNode; index: number; makeId: () => string; makeCell: () => SceneNode }): CompositionTransaction {
  const shape = readTableShape(input.table);
  if (!shape) return { scene_patches: [] };
  const index = clampInsert(input.index, shape.rows);
  const gap = gapOf(input.table.children?.[0]) ?? DEFAULT_TABLE_GAP_PX;
  const newRow: SceneNode = {
    id: input.makeId(),
    kind: 'Container',
    props: splitLayout('x', gap, shape.columnFractions.map((fraction) => ({ fraction }))),
    visible: true,
    children: Array.from({ length: shape.columns }, () => input.makeCell()),
  };
  const rowFractions = currentRowFractions(input.table, shape.rows);
  const nextRowParts = insertAt(rowFractions, index, 1).map((fraction) => ({ fraction }));
  return {
    scene_patches: [
      { type: 'INSERT_NODE', parent_id: input.table.id, index, node: newRow },
      { type: 'UPDATE_PROPS', node_id: input.table.id, changes: { props: mergeParts(input.table.props, nextRowParts) } },
    ],
  };
}

/** Remove the row at `index`: drop the row node + its row-fraction. Guard: keep ≥1 row. */
export function buildRemoveTableRowTransaction(input: { table: SceneNode; index: number }): CompositionTransaction {
  const shape = readTableShape(input.table);
  if (!shape || shape.rows < 2) return { scene_patches: [] };
  const index = clampExisting(input.index, shape.rows);
  const row = (input.table.children ?? [])[index];
  const nextRowParts = removeAt(currentRowFractions(input.table, shape.rows), index).map((fraction) => ({ fraction }));
  const scene_patches: ScenePatch[] = [];
  if (row) scene_patches.push({ type: 'REMOVE_SUBTREE', node_id: row.id });
  scene_patches.push({ type: 'UPDATE_PROPS', node_id: input.table.id, changes: { props: mergeParts(input.table.props, nextRowParts) } });
  return { scene_patches };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The table's own Y-split row fractions, or equal weights if desynced from the row count. */
function currentRowFractions(table: SceneNode, rows: number): number[] {
  const parts = partsOf(table);
  return (parts.length === rows ? parts : equalParts(rows)).map((p) => p.fraction);
}

function insertAt<T>(arr: readonly T[], index: number, value: T): T[] {
  const out = arr.slice();
  out.splice(Math.max(0, Math.min(Math.floor(index), out.length)), 0, value);
  return out;
}

function removeAt<T>(arr: readonly T[], index: number): T[] {
  const out = arr.slice();
  if (index >= 0 && index < out.length) out.splice(index, 1);
  return out;
}

/** Clamp an INSERT index to [0, len] (an insert may go after the last element). */
function clampInsert(index: number, len: number): number {
  return Math.max(0, Math.min(Math.floor(index), len));
}

/** Clamp an EXISTING-element index to [0, len-1]. */
function clampExisting(index: number, len: number): number {
  return Math.max(0, Math.min(Math.floor(index), len - 1));
}

function layoutOf(node: SceneNode | null | undefined): Record<string, unknown> | null {
  const props = isRecord(node?.props) ? (node!.props as Record<string, unknown>) : null;
  const style = props && isRecord(props.style) ? (props.style as Record<string, unknown>) : null;
  return style && isRecord(style.layout) ? (style.layout as Record<string, unknown>) : null;
}

function isSplitAxis(layout: Record<string, unknown> | null, axis: 'x' | 'y'): boolean {
  if (!layout) return false;
  const mode = typeof layout.mode === 'string' ? layout.mode.toLowerCase() : '';
  const a = typeof layout.axis === 'string' ? layout.axis.toLowerCase() : 'x';
  return mode === 'split' && a === axis;
}

function partsOf(node: SceneNode | null | undefined): SplitPart[] {
  const layout = layoutOf(node);
  const raw = layout && Array.isArray(layout.parts) ? (layout.parts as unknown[]) : [];
  return raw.map((p) => ({ fraction: isRecord(p) && typeof p.fraction === 'number' && Number.isFinite(p.fraction) ? p.fraction : 1 }));
}

function gapOf(node: SceneNode | null | undefined): number | null {
  const layout = layoutOf(node);
  return layout && typeof layout.gap === 'number' ? (layout.gap as number) : null;
}

function mergeParts(props: Record<string, unknown> | undefined, parts: SplitPart[]): Record<string, unknown> {
  const existing = isRecord(props) ? props : {};
  const style = isRecord(existing.style) ? existing.style : {};
  const layout = isRecord(style.layout) ? style.layout : {};
  return { ...existing, style: { ...style, layout: { ...layout, mode: 'split', parts } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
