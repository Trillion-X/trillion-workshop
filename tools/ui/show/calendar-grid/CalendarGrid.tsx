// bitfield-studio/frontends/web/src/packages/ui/calendar-grid/CalendarGrid.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Domain-blind date-bucket grid. Arranges an arbitrary list of date cells into
// a fixed-column grid (7 columns = a week, by default) with an optional column
// header row and a render-prop slot for content inside each cell. It knows
// NOTHING about what a cell contains — posts, events, jobs, reservations, or
// anything a caller invents are all just slotted children. The caller formats
// every visible string (day number, weekday header); this primitive only lays
// out, marks state (current/selected/muted/disabled), and routes selection.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary — no "post", "channel", "schedule", "publish",
//    "event". A cell is a cell. Content arrives via renderCell.
// 2. Column count is data (default 7). The grid template is computed from it,
//    so a caller can build a week, a fortnight strip, or any N-column board.
// 3. All visible text is caller-supplied (label, columnLabels, ariaLabel).
// 4. Density is the only visual variant this primitive owns (comfortable /
//    compact) — it is the natural bedrock for calendar cell sizing (L088),
//    so callers never hand-roll min-heights.
// 5. Selection is routed, not owned — onSelectCell fires the cell key; the
//    caller holds selection truth and passes `selected` back down.
// 6. A cell with slot content (renderCell) is a gridcell holding its own day
//    button and the content beside it, never content inside a button, so the
//    content may itself be interactive or draggable. Every cell carries
//    `data-calendar-cell-key`, so a caller's drag handlers find the cell under
//    the pointer; `dropTarget` marks the cell a drag would land on.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANTS — density is the only visual lever this primitive owns.
// ---------------------------------------------------------------------------

const calendarCellVariants = cva(
  // Base: a vertical cell with a label row at the top and slot content below.
  'group relative flex min-w-0 flex-col gap-1 rounded-lg border text-left transition-colors',
  {
    variants: {
      density: {
        /** Roomy cells with space for several slotted items. */
        comfortable: 'min-h-24 p-2',
        /** Tight cells for dense month grids or small viewports. */
        compact: 'min-h-14 p-1',
        /** Date-picker cells for narrow containers: square, centred number,
         *  a count badge instead of slotted items (Calendly / 21st.dev
         *  "calendar with event dots" anatomy). */
        picker: 'aspect-square min-h-0 items-center justify-center gap-0.5 p-0.5 text-center',
      },
      tone: {
        /** A normal in-range day. */
        default:
          'border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] hover:bg-[var(--glass-bg-hover)]',
        /** Out-of-range / padding day — de-emphasized. */
        muted:
          'border-transparent bg-transparent text-[var(--text-muted)] hover:bg-[var(--glass-bg-subtle)]',
        /** The current day — accented frame. */
        current:
          'border-[var(--border-focus)] bg-[var(--glass-bg-subtle)] hover:bg-[var(--glass-bg-hover)]',
      },
      selected: {
        true: 'ring-1 ring-[var(--border-focus)] bg-[var(--glass-bg-active)]',
        false: '',
      },
      dropTarget: {
        true: 'ring-2 ring-[var(--border-focus)] bg-[var(--glass-bg-hover)]',
        false: '',
      },
      interactive: {
        true: 'cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
        false: 'cursor-default',
      },
    },
    defaultVariants: {
      density: 'comfortable',
      tone: 'default',
      selected: false,
      dropTarget: false,
      interactive: true,
    },
  },
);

const calendarLabelVariants = cva('font-semibold tabular-nums', {
  variants: {
    density: {
      comfortable: 'text-xs text-[var(--text-secondary)]',
      compact: 'text-[length:var(--font-size-caption)] text-[var(--text-muted)]',
      picker: 'text-sm text-[var(--text-secondary)]',
    },
    current: {
      true: 'text-[var(--text-primary)]',
      false: '',
    },
  },
  defaultVariants: { density: 'comfortable', current: false },
});

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type CalendarGridDensity = NonNullable<
  VariantProps<typeof calendarCellVariants>['density']
>;

export interface CalendarGridCell {
  /** Stable identity — used as the React key and the onSelectCell argument. */
  key: string;
  /** Corner label (e.g. a day number). Caller-formatted; optional. */
  label?: string;
  /** Accessible name for the cell when its visible label needs more context. */
  ariaLabel?: string;
  /** Number of items on this cell, drawn as a small badge ("1", "3+"). */
  count?: number;
  /** De-emphasize this cell (e.g. days outside the active range). */
  muted?: boolean;
  /** Mark this cell as the current day. */
  current?: boolean;
  /** Mark this cell as selected (selection truth lives with the caller). */
  selected?: boolean;
  /** Disable interaction — the cell renders but cannot be selected. */
  disabled?: boolean;
  /** Mark this cell as where a dragged thing would land. */
  dropTarget?: boolean;
}

export interface CalendarGridProps {
  /** The cells to lay out, in reading order (row-major across columns). */
  cells: CalendarGridCell[];
  /** Number of columns. Default 7 (a calendar week). */
  columns?: number;
  /** Optional header labels, one per column (e.g. weekday names). */
  columnLabels?: string[];
  /** Cell sizing density. */
  density?: CalendarGridDensity;
  /** Counts above this draw as "limit+". Default 3. */
  countLimit?: number;
  /** Accessible name for the grid (caller-supplied, domain language). */
  ariaLabel: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Fired with a cell key when an enabled cell is activated. */
  onSelectCell?: (key: string) => void;
  /** Render slot content inside a cell, below its label. */
  renderCell?: (cell: CalendarGridCell) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/** How many things a cell holds, as a small badge ("1", "3+"). */
function CountBadge({ count, countLimit }: { count: number; countLimit: number }) {
  return (
    <span
      data-calendar-cell-count=""
      aria-hidden="true"
      className="min-w-4 rounded-full bg-[var(--accent-primary,var(--border-focus))] px-1 text-[10px] font-semibold leading-4 text-[var(--text-on-accent,var(--bg-primary))] tabular-nums"
    >
      {count > countLimit ? `${countLimit}+` : count}
    </span>
  );
}

export function CalendarGrid({
  cells,
  columns = 7,
  columnLabels,
  density = 'comfortable',
  countLimit = 3,
  ariaLabel,
  className,
  onSelectCell,
  renderCell,
}: CalendarGridProps) {
  // Dynamic column count cannot be a fixed utility class — drive the template
  // from data via style. This is the primitive bedrock; callers never touch it.
  const templateStyle: React.CSSProperties = {
    gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
  };

  return (
    <div role="grid" aria-label={ariaLabel} className={cn('flex flex-col gap-2', className)}>
      {columnLabels && columnLabels.length > 0 ? (
        <div role="row" className="grid gap-2" style={templateStyle}>
          {columnLabels.map((label, index) => (
            <div
              key={`${label}-${index}`}
              role="columnheader"
              className="px-1 text-center text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]"
            >
              {label}
            </div>
          ))}
        </div>
      ) : null}

      <div role="row" className={cn('grid', density === 'picker' ? 'gap-1' : 'gap-2')} style={templateStyle}>
        {cells.map((cell) => {
          const tone = cell.current ? 'current' : cell.muted ? 'muted' : 'default';
          const interactive = !cell.disabled && Boolean(onSelectCell);
          const cellClass = cn(
            calendarCellVariants({
              density,
              tone,
              selected: Boolean(cell.selected),
              dropTarget: Boolean(cell.dropTarget),
              interactive: renderCell ? false : interactive,
            }),
            cell.disabled && 'opacity-40',
          );
          if (renderCell) {
            // Invariant 6: the day button and the slot content sit side by side inside the gridcell.
            return (
              <div
                key={cell.key}
                data-calendar-cell-key={cell.key}
                role="gridcell"
                aria-selected={cell.selected ? true : undefined}
                aria-disabled={cell.disabled ? true : undefined}
                className={cellClass}
              >
                <button
                  type="button"
                  aria-label={cell.ariaLabel}
                  disabled={cell.disabled || !onSelectCell}
                  onClick={interactive ? () => onSelectCell?.(cell.key) : undefined}
                  className={cn(
                    'flex items-center gap-1 self-start rounded-md px-0.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
                    interactive ? 'cursor-pointer hover:text-[var(--text-primary)]' : 'cursor-default',
                  )}
                >
                  {cell.label !== undefined ? (
                    <span className={calendarLabelVariants({ density, current: Boolean(cell.current) })}>{cell.label}</span>
                  ) : null}
                  {cell.count ? <CountBadge count={cell.count} countLimit={countLimit} /> : null}
                </button>
                <div className="flex min-w-0 flex-col gap-1">{renderCell(cell)}</div>
              </div>
            );
          }
          return (
            <button
              key={cell.key}
              data-calendar-cell-key={cell.key}
              type="button"
              role="gridcell"
              aria-label={cell.ariaLabel}
              aria-selected={cell.selected ? true : undefined}
              aria-disabled={cell.disabled ? true : undefined}
              disabled={cell.disabled}
              onClick={interactive ? () => onSelectCell?.(cell.key) : undefined}
              className={cellClass}
            >
              {cell.label !== undefined ? (
                <span
                  className={cn(
                    calendarLabelVariants({ density, current: Boolean(cell.current) }),
                  )}
                >
                  {cell.label}
                </span>
              ) : null}
              {cell.count ? <CountBadge count={cell.count} countLimit={countLimit} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
