// frontends/web/src/packages/ui/table/Table.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Compound table component with styled subcomponents: Table, TableHeader,
// TableBody, TableRow, TableHead, TableCell. Provides consistent table styling
// across the application with glassmorphic borders and hover effects.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Table is the root container with w-full text-left layout
// 2. TableRow has hover:bg-[var(--glass-bg-subtle)] transition for interactivity
// 3. TableHead (th) has text-xs font-semibold text-[var(--text-tertiary)] pb-2 pr-3 styling
// 4. TableCell (td) has py-2 pr-3 text-xs baseline styling
// 5. All components extend React's native element attributes for full control
// 6. Borders use white/5 and white/10 opacity for glassmorphism
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full text-left', className)} {...props} />;
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('', className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('', className)} {...props} />;
}

interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Highlight row as selected (active background) */
  selected?: boolean
  /** Show pointer cursor on hover (clickable rows) */
  interactive?: boolean
}

export function TableRow({ className, selected, interactive, ...props }: TableRowProps) {
  return (
    <tr
      className={cn(
        'border-b border-[var(--border-primary)] hover:bg-[var(--glass-bg-subtle)] transition-colors',
        selected && 'bg-[var(--glass-bg-active)]',
        interactive && 'cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}

interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Fixed pixel width (grid column sizing — persisted view data upstream). */
  width?: number
}

export const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  function TableHead({ className, width, style, ...props }, ref) {
    return (
      <th
        ref={ref}
        className={cn('relative text-xs font-semibold text-[var(--text-tertiary)] pb-2 pr-3', className)}
        style={width ? { width, maxWidth: width, ...style } : style}
        {...props}
      />
    );
  },
);

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Single focused grid cell — accent inset ring (spreadsheet focus). */
  focused?: boolean
  /** Cell inside an active range selection. */
  selected?: boolean
  /** Fixed pixel width matching the column's TableHead. */
  width?: number
  /**
   * Give an interactive cell a 44×44px minimum coarse-pointer hit area.
   * The media-qualified utilities leave fine-pointer desktop density intact.
   */
  coarsePointerTarget?: boolean
}

export function TableCell({
  className,
  focused,
  selected,
  width,
  style,
  coarsePointerTarget = false,
  ...props
}: TableCellProps) {
  return (
    <td
      data-coarse-pointer-target={coarsePointerTarget || undefined}
      className={cn(
        'py-2 pr-3 text-xs',
        focused && 'shadow-[inset_0_0_0_2px_var(--accent-primary)]',
        !focused && selected && 'bg-[var(--glass-bg-active)]',
        coarsePointerTarget && '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11',
        className,
      )}
      style={width ? { width, maxWidth: width, ...style } : style}
      {...props}
    />
  );
}

/** Column resize grip pinned to a TableHead's trailing edge. The consumer owns
 *  the width state and persistence; this shared primitive owns pointer and
 *  keyboard input, bounds, and the accessible separator value. */
export function TableColumnResizeHandle({
  label,
  width,
  minWidth = 64,
  maxWidth = 720,
  step = 16,
  className,
  onResize,
  onCommit,
  ...props
}: {
  /** Accessible name, e.g. "Resize Title column". */
  label: string
  /** Current width in CSS pixels, controlled by the table owner. */
  width: number
  minWidth?: number
  maxWidth?: number
  /** Keyboard width change in CSS pixels. */
  step?: number
  className?: string
  /** Update the visible width; called during dragging and keyboard resizing. */
  onResize: (width: number) => void
  /** Persist the width after a completed drag or keyboard resize. */
  onCommit?: (width: number) => void
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'onResize' | 'onChange'>) {
  const start = React.useRef<{ pointerId: number; clientX: number; width: number } | null>(null);
  const clamp = (nextWidth: number) => Math.max(minWidth, Math.min(maxWidth, Math.round(nextWidth)));
  const currentWidth = clamp(width);

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={currentWidth}
      tabIndex={0}
      {...props}
      className={cn(
        'absolute top-0 right-0 bottom-0 z-[7] w-1.5 cursor-col-resize touch-none select-none hover:bg-[var(--accent-primary)]',
        className,
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        start.current = { pointerId: event.pointerId, clientX: event.clientX, width: currentWidth };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const initial = start.current;
        if (initial?.pointerId === event.pointerId) {
          onResize(clamp(initial.width + event.clientX - initial.clientX));
        }
      }}
      onPointerUp={(event) => {
        const initial = start.current;
        if (initial?.pointerId === event.pointerId) {
          const nextWidth = clamp(initial.width + event.clientX - initial.clientX);
          start.current = null;
          onResize(nextWidth);
          onCommit?.(nextWidth);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        const initial = start.current;
        if (initial?.pointerId === event.pointerId) {
          start.current = null;
          onResize(initial.width);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const nextWidth = clamp(currentWidth + (event.key === 'ArrowRight' ? step : -step));
        onResize(nextWidth);
        onCommit?.(nextWidth);
      }}
    />
  );
}
