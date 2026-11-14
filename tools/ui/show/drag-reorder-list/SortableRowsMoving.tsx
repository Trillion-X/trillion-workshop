// packages/ui/show/drag-reorder-list/SortableRowsMoving.tsx
//
// PURPOSE
// The moving half of SortableRows.tsx: framer-motion Reorder rows that follow the
// pointer and slide aside. Fetched when a list first draws (SortableRows.tsx),
// so a page does not carry the motion library before anything is shown.

import React from 'react';
import {Reorder, motion, useDragControls, useMotionValue, useReducedMotion, useTransform} from 'framer-motion';
import {sayHappened} from '../happened/happened';
import { cn } from '../cn';
import {INSTANT, MOVE_KEYS, SHIFT, fromOwnHandle, keyboardOrder, sameOrder, type SortableRowsProps} from './SortableRows';

// The row a drag moved, so whoever answers the happened event (parts/feel) can move or mark that row.
const rowOf = (event: Event) => (event.target as Element | null)?.closest?.('[data-reorder-id]') ?? null;

function SortableRow({id, disabled, reduced, className, onLift, onDrop, onKeyMove, children}: {
  id: string;
  disabled: boolean;
  reduced: boolean;
  className?: string;
  onLift: (lifted: boolean) => void;
  onDrop: (id: string) => void;
  onKeyMove: (id: string, key: string) => void;
  children: React.ReactNode;
}) {
  const controls = useDragControls();
  // How far the row is drawn from its place in the list; the landing line is
  // drawn back by the same amount, so it always sits in the gap the row will fill.
  const offset = useMotionValue(0);
  const slot = useTransform(offset, (value) => -value);
  const [lifted, setLifted] = React.useState(false);
  return (
    <Reorder.Item
      as="div"
      value={id}
      dragListener={false}
      dragControls={controls}
      style={{y: offset}}
      transition={reduced ? INSTANT : SHIFT}
      data-reorder-id={id}
      data-reorder-lifted={lifted ? '' : undefined}
      className={cn('relative', className)}
      onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
        if (disabled || event.button !== 0 || !fromOwnHandle(event, event.currentTarget)) return;
        event.preventDefault();
        controls.start(event);
      }}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled || !MOVE_KEYS.has(event.key) || !fromOwnHandle(event, event.currentTarget)) return;
        event.preventDefault();
        event.stopPropagation();
        onKeyMove(id, event.key);
      }}
      onDragStart={(event: MouseEvent | TouchEvent | PointerEvent) => { setLifted(true); onLift(true); sayHappened({event_kind: 'lifted', target: rowOf(event)}); }}
      onDragEnd={(event: MouseEvent | TouchEvent | PointerEvent) => { setLifted(false); onLift(false); onDrop(id); sayHappened({event_kind: 'dropped', target: rowOf(event)}); }}
    >
      {lifted ? <motion.div aria-hidden="true" data-reorder-slot="" style={{y: slot}} /> : null}
      {children}
    </Reorder.Item>
  );
}

export function MovingSortableRows<T>({items, getId, renderItem, onReorder, disabled = false, className, rowClassName}: SortableRowsProps<T>) {
  const ids = React.useMemo(() => items.map(getId), [items, getId]);
  // The order while a row is dragged, then until the caller's saved order arrives.
  const [held, setHeld] = React.useState<string[] | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const idsKey = ids.join('\u0000');
  React.useEffect(() => { setHeld(null); }, [idsKey]);
  const order = held && held.length === ids.length && held.every((id) => ids.includes(id)) ? held : ids;
  const latest = React.useRef(order);
  latest.current = order;
  const reduced = useReducedMotion() === true;
  const byId = new Map(items.map((item) => [getId(item), item]));

  const commit = (next: string[], id: string) => {
    if (sameOrder(next, ids)) { setHeld(null); return; }
    setHeld(next);
    const at = next.indexOf(id);
    void Promise.resolve(onReorder(next, {id, before: next[at + 1] ?? null, after: next[at - 1] ?? null})).catch(() => setHeld(null));
  };

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={order}
      onReorder={(next: string[]) => setHeld(next)}
      data-reorder-list=""
      data-reorder-dragging={dragging ? '' : undefined}
      className={cn('flex flex-col', className)}
    >
      {order.map((id) => {
        const item = byId.get(id);
        return item === undefined ? null : (
          <SortableRow
            key={id}
            id={id}
            disabled={disabled}
            reduced={reduced}
            className={rowClassName}
            onLift={setDragging}
            onDrop={(moved) => commit(latest.current, moved)}
            onKeyMove={(moved, key) => { const next = keyboardOrder(latest.current, moved, key); if (next) commit(next, moved); }}
          >
            {renderItem(item)}
          </SortableRow>
        );
      })}
    </Reorder.Group>
  );
}
