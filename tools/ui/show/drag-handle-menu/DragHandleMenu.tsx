// packages/ui/show/drag-handle-menu/DragHandleMenu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The block-editor handle affordance (Notion/Craft reference anatomy): a
// 2-column x 3-row dot grip that is invisible until its row/block is hovered,
// and opens a glass actions menu when pressed. Generic — the caller supplies
// the actions; this primitive knows nothing about blocks, scenes, or rows.
//
// Usage:
//   <HoverRevealGroup>            // the hovered region
//     <DragHandleMenu
//       aria-label="Block actions"
//       actions={[
//         { label: 'Add above', onSelect: () => ... },
//         { label: 'Delete', danger: true, onSelect: () => ... },
//       ]}
//     />
//     ...block content...
//   </HoverRevealGroup>
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: no product vocabulary; actions are caller data (L090).
// 2. Hidden at rest — reveal is HoverRevealItem (opacity-only, focus-safe).
// 3. Menu surface uses the shared glass tokens (never see-through).
// 4. mousedown (not click) with preventDefault so an active contenteditable
//    selection/caret is never blurred by opening the menu.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { GripVertical } from 'lucide-react';

import { cn } from '../cn';
import { HoverRevealItem } from '../hover-reveal';
import { Icon } from '../icon';
import { Dropdown, type DropdownItem } from '../dropdown';

export type DragHandleAction = {
  label: string;
  section?: string;
  danger?: boolean;
  onSelect?: () => void;
  children?: DragHandleAction[];
};

export type DragHandleMenuProps = {
  actions: DragHandleAction[] | (() => DragHandleAction[]);
  'aria-label': string;
  /** Optional data category shown on filtered hierarchical search results. */
  section?: string;
  /** Additional className for the handle button (e.g. positioning). */
  className?: string;
  /** Optional drag plumbing: press-and-move starts a drag instead of the
   * menu; a clean press-release still opens the menu. Caller owns meaning. */
  onDragStart?: (event: React.PointerEvent) => void;
};

export function DragHandleMenu({ actions, className, onDragStart, section, ...aria }: DragHandleMenuProps) {
  const [open, setOpen] = React.useState(false);
  const press = React.useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = React.useRef(false);
  // A menu can project expensive live choices only while it is open. A document
  // with many handles must not scan its whole tree for every closed handle.
  const availableActions = typeof actions === 'function' ? (open ? actions() : []) : actions;
  const choices = (rows: DragHandleAction[], prefix = ''): DropdownItem[] =>
    rows.map((action, index) => ({
      value: `${prefix}${index}`, label: action.label,
      ...(action.section || (prefix === '' && section) ? { section: action.section ?? section } : {}),
      ...(action.danger ? { tint: 'var(--status-error, #dc2626)' } : {}),
      ...(action.children?.length ? { children: choices(action.children, `${prefix}${index}/`) } : {}),
    }));
  const choose = (value: string) => {
    let rows = availableActions;
    let selected: DragHandleAction | undefined;
    for (const index of value.split('/')) {
      selected = rows[Number(index)];
      if (!selected) return;
      rows = selected.children ?? [];
    }
    selected?.onSelect?.();
  };
  // Reuse the shared portal, viewport collision, keyboard navigation and outside
  // dismissal owner. Pointer-down alone never activates an action: mouse,
  // keyboard and touch all complete through the same click/selection path.
  return (
    <HoverRevealItem revealed={open} className={cn('inline-flex', className)}>
      <Dropdown
        items={choices(availableActions)}
        value=""
        aria-label={aria['aria-label']}
        searchable
        searchLabel="Search actions"
        open={open}
        onOpenChange={setOpen}
        onValueChange={choose}
        customTrigger={
          <button
            type="button"
            aria-label={aria['aria-label']}
            className={cn(
              'flex h-6 w-4 items-center justify-center rounded',
              'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
              'cursor-grab',
            )}
            onMouseDown={event => event.preventDefault()}
            onClick={event => {
              if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; }
            }}
            onPointerDown={onDragStart ? event => {
              if (event.button !== 0) return;
              suppressClick.current = false;
              press.current = { x: event.clientX, y: event.clientY, dragging: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            } : undefined}
            onPointerMove={onDragStart ? event => {
              const start = press.current;
              if (!start || start.dragging) return;
              if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
                start.dragging = true;
                setOpen(false);
                onDragStart(event);
              }
            } : undefined}
            onPointerUp={onDragStart ? event => {
              suppressClick.current = press.current?.dragging ?? false;
              press.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            } : undefined}
            onPointerCancel={() => { press.current = null; suppressClick.current = false; }}
          >
            <Icon icon={GripVertical} size="sm" color="faint" />
          </button>
        }
      />
    </HoverRevealItem>
  );
}
