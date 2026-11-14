// packages/ui/show/tool-tile/ToolTile.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Rounded tool button for floating tool rails and palette grids. Renders a
// Lucide icon in an inset rounded square, with label and optional detail text.
// Supports row (icon-left) and column (icon-over-label) orientations.
// Selected state produces an accent border glow.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL colors use CSS vars from ApplyCurrentScreenLook token set
// 2. icon prop accepts LucideIcon type — never a string
// 3. selected glow uses box-shadow only — no outline/ring that leaks outside
// 4. orientation='column' centers; orientation='row' aligns left
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const toolTileVariants = cva(
  'rounded-xl border transition-colors cursor-pointer select-none',
  {
    variants: {
      orientation: {
        row: 'flex flex-row items-center gap-3 px-3 py-2.5',
        column: 'flex flex-col items-center gap-2 px-3 py-3',
      },
      selected: {
        true: [
          'border-[var(--border-focus)]',
          'bg-[var(--glass-bg-active)]',
          'shadow-[0_0_0_1px_var(--accent-primary),0_0_12px_2px_color-mix(in_srgb,var(--accent-primary)_30%,transparent)]',
        ],
        false: [
          'border-transparent',
          'bg-transparent',
          'hover:bg-[var(--glass-bg-hover)]',
        ],
      },
    },
    defaultVariants: {
      orientation: 'row',
      selected: false,
    },
  }
);

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface ToolTileProps extends VariantProps<typeof toolTileVariants> {
  label: string;
  detail?: string;
  icon: LucideIcon;
  onClick?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Floating tool rail button with icon inset, label, and optional detail.
 *
 * @example
 * ```tsx
 * <ToolTile icon={Scissors} label="Cut" selected />
 * <ToolTile icon={Layers} label="Blend" detail="Overlay" orientation="column" />
 * ```
 */
export function ToolTile({
  label,
  detail,
  icon: IconComponent,
  selected = false,
  orientation = 'row',
  onClick,
  className,
}: ToolTileProps) {
  const isColumn = orientation === 'column';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(toolTileVariants({ orientation, selected }), className)}
    >
      {/* Icon inset square */}
      <div
        className={cn(
          'shrink-0 flex items-center justify-center rounded-lg',
          'bg-[var(--glass-bg-hover)] border border-[var(--border-primary)]',
          isColumn ? 'w-10 h-10' : 'w-8 h-8',
        )}
      >
        <IconComponent
          className={cn(
            'shrink-0',
            selected ? 'text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]',
            isColumn ? 'w-5 h-5' : 'w-4 h-4',
          )}
        />
      </div>

      {/* Text stack */}
      <div className={cn('flex flex-col', isColumn ? 'items-center' : 'items-start', 'min-w-0')}>
        <span
          className={cn(
            'text-sm font-semibold leading-tight truncate',
            selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {label}
        </span>
        {detail && (
          <span className="text-xs text-[var(--text-muted)] leading-tight truncate">
            {detail}
          </span>
        )}
      </div>
    </button>
  );
}
