// packages/ui/show/drag-reorder-list/SortableRows.tsx
//
// PURPOSE
// The one sortable for vertical lists (a sidebar list, filter rules, menu rows,
// layers). A row is picked up by its handle (any element inside it marked
// `data-reorder-handle`) and follows the pointer; the other rows slide aside
// live to open the gap, and a line in that gap marks where the row lands and
// moves with it. The dropped order shows at once and stays until the caller's
// saved order arrives, so nothing jumps back. Keyboard: on a focused handle,
// ArrowUp/ArrowDown move one place, Home/End to either end.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Blind: rows are the caller's elements; this names no row kind.
// 2. Pointer events drive the drag (framer-motion Reorder), never native HTML5
//    drag, so rows move while dragging in every engine, WebKit included (a
//    native drag session in WKWebView does not repaint the list mid-drag). A
//    row may still carry its own native drag elsewhere (a sidebar row body
//    dropped on a pane); only the handle sorts.
// 3. Only the nearest row of a handle moves, so nested lists never drive a parent.
// 4. `onReorder` fires once per drop or keyboard move, only when the order
//    changed, with the new order and the moved row's neighbours.
// 5. Appearance lives in screen-look/show/drag-reorder.css; motion is a spring,
//    instant under reduced motion.
// 6. A pick-up and a drop are said on the happened channel (`lifted`, `dropped`)
//    with the row, so the device's feel answers them (parts/feel).
// 7. The moving rows (SortableRowsMoving.tsx, framer-motion) are fetched when a
//    list first draws; until they arrive the same rows draw still, in order.
//
// Reference: 21st.dev #23550 "Reorder List" (ddoemonn), framer-motion
// Reorder.Group/Reorder.Item with spring-shifted rows, a lifted row under the
// pointer and keyboard moves; adapted to a caller-marked handle.

import React from 'react';
import { cn } from '../cn';

export interface SortableMove {
  id: string;
  /** The row now after the moved one, or null at the end. */
  before: string | null;
  /** The row now before the moved one, or null at the start. */
  after: string | null;
}

export interface SortableRowsProps<T> {
  items: readonly T[];
  getId: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Once per drop or keyboard move. A rejected promise puts the saved order back. */
  onReorder: (order: string[], moved: SortableMove) => void | Promise<unknown>;
  disabled?: boolean;
  className?: string;
  rowClassName?: string;
}

export const SHIFT = {type: 'spring', stiffness: 520, damping: 34, mass: 0.45} as const;
export const INSTANT = {duration: 0} as const;
export const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** The order after moving `id` by a keyboard key, or null when it cannot move. */
export function keyboardOrder(order: readonly string[], id: string, key: string): string[] | null {
  const from = order.indexOf(id);
  if (from < 0 || !MOVE_KEYS.has(key)) return null;
  const to = key === 'ArrowUp' ? from - 1 : key === 'ArrowDown' ? from + 1 : key === 'Home' ? 0 : order.length - 1;
  if (to < 0 || to >= order.length || to === from) return null;
  const next = order.filter((value) => value !== id);
  next.splice(to, 0, id);
  return next;
}

/** True when the event came from a handle whose nearest row is `row`. */
export function fromOwnHandle(event: React.SyntheticEvent, row: Element): boolean {
  const handle = (event.target as Element | null)?.closest?.('[data-reorder-handle]');
  return !!handle && handle.closest('[data-reorder-id]') === row;
}

// The moving rows' code, fetched the first time any list draws; every list waits on the same fetch.
type Moving = typeof import('./SortableRowsMoving').MovingSortableRows;
let moving: Moving | null = null;
let arriving: Promise<void> | null = null;
const fetchMoving = () => (arriving ??= import('./SortableRowsMoving').then((module) => { moving = module.MovingSortableRows; }));

export function SortableRows<T>(props: SortableRowsProps<T>) {
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => { if (!moving) void fetchMoving().then(redraw, () => {}); }, []);
  if (moving) return React.createElement(moving as (props: SortableRowsProps<T>) => React.ReactElement, props);
  const {items, getId, renderItem, className, rowClassName} = props;
  return (
    <div data-reorder-list="" className={cn('flex flex-col', className)}>
      {items.map((item) => <div key={getId(item)} data-reorder-id={getId(item)} className={cn('relative', rowClassName)}>{renderItem(item)}</div>)}
    </div>
  );
}
