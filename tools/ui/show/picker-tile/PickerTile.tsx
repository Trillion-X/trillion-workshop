// packages/ui/show/picker-tile/PickerTile.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared picker-tile anatomy for surface/folder/layout choosers: a rounded
// glass tile with a leading icon well, a title plus subtitle, a trailing slot,
// and a 2x2 mini-icon grid in the well when several member icons are given
// (iOS-folder anatomy). Lives in ui/ so every catalog-like grid (New-tab
// picker, folder contents, template galleries) renders one tile idiom.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Glass tokens only (--glass-bg-*, --border-*, --text-*) — themeable.
// 2. The tile is a Button (focusable, aria-labelled) — never a bare div.
// 3. The icon well renders EITHER one icon or a mini grid, chosen by which
//    props carry data — callers never branch on tile kind.
// 4. Ref-forwarded to the underlying button element so callers can anchor a
//    floating panel (AnchoredOverlay) to a specific tile without a wrapper.
// 5. `selected` is a pure caller-owned visual flag (accent ring/border) — the
//    tile never owns selection state itself, mirroring MediaThumb's `selected`
//    prop convention so every catalog-like grid shows the same selected idiom.
//
// =============================================================================

import React from 'react';
import { Button } from '../button/Button';
import { NamedIcon } from '../icon';
import { MediaThumb } from '../media-thumb';
import { cn } from '../cn';

export interface PickerTileProps {
  title: string;
  subtitle?: string;
  /** Single icon name for the leading well (ignored when previewIcons or family given). */
  icon?: string;
  /** Up to 4 icon names rendered as a 2x2 mini grid in the well. */
  previewIcons?: readonly string[];
  /** Media family (MIME prefix) to render as MediaThumb in the icon well (overrides icon/previewIcons). */
  family?: string;
  /** Trailing slot (chevron, badge…). */
  trailing?: React.ReactNode;
  /** Compact = smaller well + paddings (folder contents). */
  compact?: boolean;
  /** Row = the sidebar's compact, unframed icon-and-name anatomy. */
  row?: boolean;
  /** Caller-owned selection visual (accent ring/border). Never toggled internally. */
  selected?: boolean;
  /** A hue of the shared screen-look palette the tile is drawn in (`--record-kind-<hue>`), from the item's DATA. */
  colour?: string;
  onClick?: () => void;
  onPointerEnter?: () => void;
  onFocus?: () => void;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  'aria-selected'?: boolean;
}

export const PickerTile = React.forwardRef<HTMLButtonElement, PickerTileProps>(function PickerTile({
  title,
  subtitle,
  icon,
  previewIcons,
  family,
  trailing,
  compact = false,
  row = false,
  selected = false,
  colour,
  onClick,
  onPointerEnter,
  onFocus,
  ...aria
}, ref) {
  const preview = (previewIcons ?? []).slice(0, 4);
  const hasFamily = !!family;

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      aria-label={aria['aria-label'] ?? title}
      aria-expanded={aria['aria-expanded']}
      aria-selected={aria['aria-selected']}
      data-picker-tile=""
      data-picker-tile-layout={row ? 'row' : undefined}
      data-colour={colour}
      size={row ? 'nav' : undefined}
      className={cn(
        'group min-h-0 w-full justify-start text-left',
        row
          ? 'gap-3 rounded-[var(--radius-control)] px-3 py-0'
          : compact
            ? 'h-auto rounded-xl p-2 hover:bg-[var(--glass-bg-hover)]'
            : 'h-auto rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] p-4 hover:bg-[var(--glass-bg-hover)]',
        selected && 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]',
      )}
    >
      <span className={cn('flex w-full items-center', row ? 'gap-3' : compact ? 'gap-2' : 'gap-3')}>
        {!row && hasFamily ? (
          <MediaThumb family={family} selected={selected} />
        ) : !row && preview.length > 0 ? (
          <span
            className={cn(
              'grid flex-shrink-0 grid-cols-2 grid-rows-2 gap-0.5 rounded-xl border border-[var(--border-secondary)] bg-black/20 p-1',
              compact ? 'h-8 w-8' : 'h-10 w-10',
            )}
          >
            {preview.map((name, index) => (
              <span key={`${name}-${index}`} className="flex items-center justify-center text-[var(--accent-primary)]">
                <NamedIcon name={name} size="xs" />
              </span>
            ))}
          </span>
        ) : row ? (
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-[var(--text-secondary)]">
            <NamedIcon name={icon ?? 'Square'} size="lg" />
          </span>
        ) : (
          <span
            className={cn(
              'flex flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border-secondary)] bg-black/20 text-[var(--accent-primary)]',
              compact ? 'h-8 w-8 rounded-lg' : 'h-10 w-10',
            )}
          >
            <NamedIcon name={icon ?? 'Square'} size={compact ? 'sm' : 'lg'} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', row ? 'text-[length:var(--font-size-body)] font-medium text-[var(--text-secondary)]' : 'text-sm font-semibold text-[var(--text-primary)]')}>{title}</span>
          {subtitle ? (
            <span className="block truncate text-[length:var(--font-size-caption)] text-[var(--text-tertiary)]">{subtitle}</span>
          ) : null}
        </span>
        {trailing ?? null}
      </span>
    </Button>
  );
});

PickerTile.displayName = 'PickerTile';
