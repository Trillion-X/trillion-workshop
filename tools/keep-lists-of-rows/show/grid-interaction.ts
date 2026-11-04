//
// Pure grid-interaction physics for the table view-role: focused-cell keyboard
// traversal over (row × column) INDICES, per-view column-state application
// (order / widths / hidden — Society data on the views record), and fill-down
// write assembly (ONE atomic batch, never a per-record fold). Zero field
// vocabulary, zero React, zero I/O — the surface wires these to events and the
// record writer; this module only computes.

import { buildAddressedCellValueWrites, type AddressedWrite } from '../do-work/record-write-builders';
import type {
  VisualDatabaseValueExpression,
  VisualDatabaseFieldDescriptor,
  VisualDatabaseRecord,
  VisualDatabaseViewColumnState,
} from '../read-data/visual-database';
import { recordAddress } from '../read-data/visual-database';

// ---------------------------------------------------------------------------
// Focused cell + keyboard traversal
// ---------------------------------------------------------------------------

export interface GridCell {
  rowIndex: number;
  columnIndex: number;
}

export interface GridBounds {
  rowCount: number;
  columnCount: number;
}

/** Spreadsheet traversal: arrows move one cell clamped to bounds; Tab wraps to
 *  the next row's first column (Shift-Tab the inverse). Returns null when the
 *  move leaves the grid entirely (Tab past the last cell). */
export function moveCell(
  cell: GridCell,
  bounds: GridBounds,
  move: 'up' | 'down' | 'left' | 'right' | 'next' | 'previous',
): GridCell | null {
  if (bounds.rowCount === 0 || bounds.columnCount === 0) return null;
  const clamp = (row: number, column: number): GridCell => ({
    rowIndex: Math.min(Math.max(row, 0), bounds.rowCount - 1),
    columnIndex: Math.min(Math.max(column, 0), bounds.columnCount - 1),
  });
  switch (move) {
    case 'up': return clamp(cell.rowIndex - 1, cell.columnIndex);
    case 'down': return clamp(cell.rowIndex + 1, cell.columnIndex);
    case 'left': return clamp(cell.rowIndex, cell.columnIndex - 1);
    case 'right': return clamp(cell.rowIndex, cell.columnIndex + 1);
    case 'next': {
      const flat = cell.rowIndex * bounds.columnCount + cell.columnIndex + 1;
      if (flat >= bounds.rowCount * bounds.columnCount) return null;
      return { rowIndex: Math.floor(flat / bounds.columnCount), columnIndex: flat % bounds.columnCount };
    }
    case 'previous': {
      const flat = cell.rowIndex * bounds.columnCount + cell.columnIndex - 1;
      if (flat < 0) return null;
      return { rowIndex: Math.floor(flat / bounds.columnCount), columnIndex: flat % bounds.columnCount };
    }
  }
}

/** Map a keyboard event's key to a traversal move (spreadsheet convention).
 *  Returns null for keys the grid does not own. */
export function keyToMove(key: string, shiftKey: boolean): Parameters<typeof moveCell>[2] | null {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Tab': return shiftKey ? 'previous' : 'next';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Column state application (order / widths / hidden)
// ---------------------------------------------------------------------------

/** Apply per-view column state to the descriptor-ordered column set:
 *  hidden ids drop, explicitly ordered ids lead in that order, unlisted ids
 *  trail in descriptor order. Ids referencing descriptors that no longer exist
 *  are ignored (resurrect-safe — deleting/re-adding a field never corrupts the
 *  view state). */
export function applyColumnState(
  columns: readonly VisualDatabaseFieldDescriptor[],
  state: VisualDatabaseViewColumnState | undefined,
): readonly VisualDatabaseFieldDescriptor[] {
  if (!state) return columns;
  const hidden = new Set(state.hidden ?? []);
  const visible = columns.filter((column) => !hidden.has(column.id));
  const order = state.order ?? [];
  if (order.length === 0) return visible;
  const byId = new Map(visible.map((column) => [column.id, column]));
  const led = order.map((id) => byId.get(id)).filter((column): column is VisualDatabaseFieldDescriptor => !!column);
  const ledIds = new Set(led.map((column) => column.id));
  return [...led, ...visible.filter((column) => !ledIds.has(column.id))];
}

/** Next column state after dragging `movedId` to sit before `beforeId`
 *  (null = end). The order list is rebuilt from the CURRENT visible order so a
 *  first-ever reorder starts from descriptor order, not an empty list. */
export function reorderColumnState(
  currentVisible: readonly VisualDatabaseFieldDescriptor[],
  state: VisualDatabaseViewColumnState | undefined,
  movedId: string,
  beforeId: string | null,
): VisualDatabaseViewColumnState {
  const ids = currentVisible.map((column) => column.id).filter((id) => id !== movedId);
  const at = beforeId === null ? ids.length : Math.max(ids.indexOf(beforeId), 0);
  ids.splice(at, 0, movedId);
  return { ...(state ?? {}), order: ids };
}

/** Next column state after resizing one column (min width guards a vanished
 *  column). */
export function resizeColumnState(
  state: VisualDatabaseViewColumnState | undefined,
  columnId: string,
  width: number,
): VisualDatabaseViewColumnState {
  const clamped = Math.max(Math.round(width), 60);
  return { ...(state ?? {}), widths: { ...(state?.widths ?? {}), [columnId]: clamped } };
}

/** Next column state after toggling a column hidden/shown. */
export function toggleColumnHidden(
  state: VisualDatabaseViewColumnState | undefined,
  columnId: string,
): VisualDatabaseViewColumnState {
  const hidden = new Set(state?.hidden ?? []);
  if (hidden.has(columnId)) hidden.delete(columnId);
  else hidden.add(columnId);
  return { ...(state ?? {}), hidden: [...hidden] };
}

// ---------------------------------------------------------------------------
// Generic element-property writers (the scope fan: this / all / selected)
// ---------------------------------------------------------------------------

/** Set (or clear when `value === undefined`) one open property `key` in the bags
 *  of EVERY column id in `columnIds` — the ONE generic write behind "this column /
 *  all columns / selected columns". Blind to what `key` means; width/radius/line
 *  divider/label size all fan the same way. Empty bags are pruned. */
export function setColumnStyleForScope(
  state: VisualDatabaseViewColumnState | undefined,
  columnIds: readonly string[],
  key: string,
  value: unknown,
): VisualDatabaseViewColumnState {
  const styles: Record<string, Record<string, unknown>> = {};
  for (const [id, bag] of Object.entries(state?.styles ?? {})) styles[id] = { ...(bag as Record<string, unknown>) };
  for (const id of columnIds) {
    const bag = { ...(styles[id] ?? {}) };
    if (value === undefined) delete bag[key];
    else bag[key] = value;
    if (Object.keys(bag).length > 0) styles[id] = bag;
    else delete styles[id];
  }
  const next: VisualDatabaseViewColumnState = { ...(state ?? {}) };
  if (Object.keys(styles).length > 0) next.styles = styles;
  else delete next.styles;
  return next;
}

/** Set/clear one grid-scope property key on the view's grid-style bag. */
export function setGridStyleKey<V extends { gridStyle?: Readonly<Record<string, unknown>> }>(
  view: V,
  key: string,
  value: unknown,
): V {
  const bag = { ...(view.gridStyle ?? {}) };
  if (value === undefined) delete bag[key];
  else bag[key] = value;
  return { ...view, gridStyle: Object.keys(bag).length > 0 ? bag : undefined };
}

/** Set/clear one row-scope property key on the view's row-style bag. */
export function setRowStyleKey<V extends { rowStyle?: Readonly<Record<string, unknown>> }>(
  view: V,
  key: string,
  value: unknown,
): V {
  const bag = { ...(view.rowStyle ?? {}) };
  if (value === undefined) delete bag[key];
  else bag[key] = value;
  return { ...view, rowStyle: Object.keys(bag).length > 0 ? bag : undefined };
}

// ---------------------------------------------------------------------------
// Range selection + fill-down + TSV copy
// ---------------------------------------------------------------------------

export interface GridRange {
  anchor: GridCell;
  focus: GridCell;
}

/** Normalized inclusive bounds of a range. */
export function rangeBounds(range: GridRange): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(range.anchor.rowIndex, range.focus.rowIndex),
    bottom: Math.max(range.anchor.rowIndex, range.focus.rowIndex),
    left: Math.min(range.anchor.columnIndex, range.focus.columnIndex),
    right: Math.max(range.anchor.columnIndex, range.focus.columnIndex),
  };
}

export interface CellExpressionForFill {
  expression: VisualDatabaseValueExpression;
  sourceExpectedCurrent?: { payloadHash: Uint8Array } | null;
}

export interface FillDownExpressionPlanEntry {
  /** Stable addressed source identity. Presentation labels are resolved later. */
  sourceCell: { recordRef: string; fieldRef: string };
  /** Stable addressed destination identity. It survives row/column reorder. */
  destinationCell: { recordRef: string; fieldRef: string };
  originalExpression: VisualDatabaseValueExpression;
  transformedExpression: VisualDatabaseValueExpression;
}

export interface FillDownExpressionPlan {
  /** Exact writes committed after confirmation; never rebuilt from presentation. */
  writes: readonly AddressedWrite[];
  /** One preview row per addressed destination, in visual fill order. */
  entries: readonly FillDownExpressionPlanEntry[];
}

function transformFilledExpression(expression: VisualDatabaseValueExpression, sourceRecordRef: string, targetRecordRef: string): VisualDatabaseValueExpression {
  const derive = expression.derive;
  if (!derive || derive.dependencySelector?.fillRelativeRecordRefs !== true) return expression;
  return { derive: { ...derive, dependencyRefs: derive.dependencyRefs?.map((ref) => ref.recordRef === sourceRecordRef ? { ...ref, recordRef: targetRecordRef } : ref) } };
}

/** Builds one immutable preview/commit plan. UI reviews `entries`, then commits
 * the already-bound `writes` exactly once; confirmation can never recompute
 * against a reordered or reloaded grid. */
export function buildFillDownExpressionPlan(
  records: readonly VisualDatabaseRecord[],
  columns: readonly VisualDatabaseFieldDescriptor[],
  range: GridRange,
  expressionOf: (record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor) => CellExpressionForFill,
): FillDownExpressionPlan {
  const { top, bottom, left, right } = rangeBounds(range);
  const source = records[top];
  if (!source || bottom <= top) return { writes: [], entries: [] };
  const sourceRef = recordAddress(source) ?? source.id;
  const writes: AddressedWrite[] = [];
  const entries: FillDownExpressionPlanEntry[] = [];
  for (let row = top + 1; row <= bottom; row += 1) {
    const target = records[row];
    if (!target) continue;
    const targetRef = recordAddress(target) ?? target.id;
    for (const descriptor of columns.slice(left, right + 1).filter((field) => field.editable !== false)) {
      const sourceCell = expressionOf(source, descriptor);
      const targetCell = expressionOf(target, descriptor);
      const transformedExpression = transformFilledExpression(
        sourceCell.expression,
        sourceRef,
        targetRef,
      );
      entries.push({
        sourceCell: { recordRef: sourceRef, fieldRef: descriptor.id },
        destinationCell: { recordRef: targetRef, fieldRef: descriptor.id },
        originalExpression: sourceCell.expression,
        transformedExpression,
      });
      writes.push(...buildAddressedCellValueWrites({
        cellRef: { recordRef: targetRef, fieldRef: descriptor.id },
        expression: transformedExpression,
        sourceExpectedCurrent: targetCell.sourceExpectedCurrent ?? null,
      }));
    }
  }
  return { writes, entries };
}

/** Expression-aware fill. Every target becomes an explicit addressed source;
 * formula sources remain formulas, literals remain literals, and relative
 * record refs move only when the expression descriptor declares that transform. */
export function buildFillDownExpressionWrites(
  records: readonly VisualDatabaseRecord[],
  columns: readonly VisualDatabaseFieldDescriptor[],
  range: GridRange,
  expressionOf: (record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor) => CellExpressionForFill,
): readonly AddressedWrite[] {
  return buildFillDownExpressionPlan(records, columns, range, expressionOf).writes;
}

/** TSV projection of a range for clipboard copy (spreadsheet interop). */
export function rangeToTsv(
  records: readonly VisualDatabaseRecord[],
  columns: readonly VisualDatabaseFieldDescriptor[],
  range: GridRange,
  textOf: (record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor) => string,
): string {
  const { top, bottom, left, right } = rangeBounds(range);
  const lines: string[] = [];
  for (let rowIndex = top; rowIndex <= bottom; rowIndex += 1) {
    const record = records[rowIndex];
    if (!record) continue;
    lines.push(columns.slice(left, right + 1).map((descriptor) => textOf(record, descriptor)).join('\t'));
  }
  return lines.join('\n');
}
