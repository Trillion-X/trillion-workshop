// packages/ui/show/drag-reorder-list/DragReorderList.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure vertical reorderable list. The caller owns the items array and receives
// the full new ID order on drop — this component holds only transient drag
// state and never persists anything. Drag handle is a grip icon on the left of
// each row. While dragging, the row follows the pointer, the other rows slide
// out of the way and a line marks where it lands (SortableRows, the one
// sortable). Pointer drag (mouse and touch alike) and keyboard moves.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no persistence, no addresses, no feature vocabulary
// 2. onReorder fires ONCE, on drop, with the complete new id order
// 3. Dropping an item at its own position is a no-op (no callback)
// 4. Works with mouse, touch and keyboard — same callback
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import {
  controlTargetAttributes,
  controlTargetClass,
} from '../control-target';
import {
  MoveTargetStatus,
  moveTargetMessage,
} from '../drop-indicator';
import {
  reorderIds,
} from '../reorder-control/reorder-operation';
import { SortableRows } from './SortableRows';

export interface DragReorderListItem {
  /** Stable unique id — the unit of reordering */
  id: string;
  /** Human-readable handle name. Falls back to `id` when omitted. */
  label?: string;
  /** Row content rendered to the right of the drag handle */
  content: React.ReactNode;
}

export interface DragReorderListProps {
  /** Items in current order. The caller owns this array. */
  items: readonly DragReorderListItem[];
  /** Receives the complete new id order after a successful drop */
  onReorder: (newIds: string[]) => void;
  className?: string;
  /** How the rows sit: 'plain' rows on the page (the default), or 'grouped' in one bordered group with a hairline
   *  between rows, as a settings list reads (appearance: screen-look drag-reorder.css). */
  surface?: 'plain' | 'grouped';
  /** Where the grip sits beside a row taller than one line: 'center' (the default), or 'start', level with the row's
   *  first line (a row with a title over more text). */
  handleAlign?: 'center' | 'start';
}

const itemId = (item: DragReorderListItem) => item.id;

export function DragReorderList({ items, onReorder, className, surface = 'plain', handleAlign = 'center' }: DragReorderListProps) {
  const [announcement, setAnnouncement] = React.useState('');
  const labels = React.useMemo(
    () => new Map(items.map((item) => [item.id, item.label ?? item.id])),
    [items],
  );

  return (
    <div data-reorder-surface={surface}
      className={cn('flex flex-col', className)} role="list">
      <MoveTargetStatus message={announcement} />
      <SortableRows
        items={items}
        getId={itemId}
        onReorder={(next, moved) => {
          onReorder(next);
          setAnnouncement(moveTargetMessage(
            labels.get(moved.id) ?? moved.id,
            moved.before === null ? null : labels.get(moved.before) ?? moved.before,
          ));
        }}
        renderItem={(item) => (
          <div data-reorder-row role="listitem" className={cn('flex flex-row gap-2 rounded-lg py-1', handleAlign === 'start' ? 'items-start' : 'items-center')}>
            <button
              type="button"
              data-reorder-handle
              data-target-size-desktop="28"
              {...controlTargetAttributes('reorder')}
              aria-label={`Reorder ${item.label ?? item.id}`}
              aria-keyshortcuts="ArrowUp ArrowDown Home End"
              className={cn(
                'inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md',
              handleAlign === 'start' && '-my-1',
                controlTargetClass('reorder'),
                'text-[var(--text-faint)] outline-none active:cursor-grabbing',
                'focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]',
              )}
            >
              <NamedIcon name="GripVertical" size="sm" aria-hidden />
            </button>
            <div className="min-w-0 flex-1">{item.content}</div>
          </div>
        )}
      />
    </div>
  );
}

export { reorderIds };
