// packages/ui/show/drop-indicator/DropIndicator.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The drag-and-drop insertion line: a 2px accent bar with end caps that marks
// where a dragged item will land between rows/cards. One primitive — every
// reorderable surface shows the same indicator (the screen-arrangement /
// Amie pattern: the drop target is always visibly announced).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: no product vocabulary. `active` in; nothing out.
// 2. Tokens only: accent color rides --accent-primary with a system fallback.
// 3. Zero layout shift: the line occupies a fixed 2px row and fades with
//    opacity — rows never jump while dragging across them.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { cn } from '../cn';
import {
  useReorderFeedback,
} from './reorder-feedback';

export interface DropIndicatorProps {
  /** Show the line (a drag is hovering this insertion point). */
  active: boolean;
  /** Horizontal marks insertion between rows; vertical marks between columns. */
  orientation?: 'horizontal' | 'vertical';
  /** Start marks before the target; end marks the final insertion gap. */
  placement?: 'start' | 'end';
  /** Human equivalent of the visual insertion bar. */
  announcement?: string;
}

export interface MoveTargetStatusProps {
  /** Current preview or immediate-move phrase. The node remains mounted when empty. */
  message: string;
}

/**
 * Stable assistive counterpart to every visual reorder preview.
 *
 * The accessible name is deliberately invariant so proof and assistive tools
 * can find one semantic feedback channel while its human message changes.
 */
export function MoveTargetStatus({ message }: MoveTargetStatusProps) {
  return (
    <span
      role="status"
      aria-label="Move target"
      aria-live="polite"
      aria-atomic="true"
      aria-hidden={message ? undefined : true}
      data-move-target-status
      className="sr-only"
    >
      {message}
    </span>
  );
}

export function DropIndicator({
  active,
  orientation = 'horizontal',
  placement = 'start',
  announcement,
}: DropIndicatorProps) {
  const indicatorRef = React.useRef<HTMLDivElement>(null);
  const {
    isOwner,
    message,
    publish,
    publishPlacement,
  } = useReorderFeedback(indicatorRef);

  React.useLayoutEffect(() => {
    if (!active) {
      publish('');
      return;
    }
    if (announcement) {
      publish(announcement);
      return;
    }
    const target = indicatorRef.current?.closest<HTMLElement>('[data-reorder-target-id]');
    const targetLabel = target?.dataset.reorderTargetLabel
      ?? target?.dataset.fieldLabel
      ?? target
        ?.querySelector<HTMLElement>('[data-reorder-handle][aria-label]')
        ?.getAttribute('aria-label')
        ?.replace(/^Reorder\s+/, '');
    publishPlacement(placement === 'end' ? null : targetLabel ?? 'this position');
  }, [active, announcement, placement, publish, publishPlacement]);

  return (
    <>
      <div
        ref={indicatorRef}
        aria-hidden="true"
        data-drop-indicator
        className={cn(
          'pointer-events-none rounded-full transition-opacity duration-100',
          orientation === 'horizontal'
            ? placement === 'start'
              ? 'h-[2px] w-full'
              : 'absolute inset-x-0 bottom-0 h-[2px] w-full'
            : placement === 'start'
              ? 'absolute inset-y-0 left-0 h-full w-[2px]'
              : 'absolute inset-y-0 right-0 h-full w-[2px]',
          'bg-[var(--accent-primary,#3B82F6)]',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
      {isOwner ? <MoveTargetStatus message={message} /> : null}
    </>
  );
}
