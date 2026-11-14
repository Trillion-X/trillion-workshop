// frontends/web/src/packages/ui/diff-view/DiffView.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Reusable unified diff viewer component. Displays diff lines with color-coded
// backgrounds (red for removed, green for added) and a line-number gutter.
// Uses @tanstack/react-virtual for virtualization when >100 lines to keep
// rendering performant for large diffs.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Added lines: bg-[var(--diff-added-bg)], text-[var(--diff-added-text)]
// 2. Removed lines: bg-[var(--diff-removed-bg)], text-[var(--diff-removed-text)]
// 3. Unchanged lines: text-[var(--text-tertiary)] (subtle)
// 4. Line-number gutter shows old/new numbers (or empty if not applicable)
// 5. Virtualizer kicks in for >100 lines (configurable)
// 6. maxHeight optional prop controls container max-height (default 24rem/384px)
// 7. font-mono text-xs — monospace code font at small size
// 8. glass-tertiary background (from design system)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useMemo, useRef } from 'react';
import { cn } from '../cn';
import type { DiffLine } from './diff-logic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/**
 * Props for the DiffView component.
 */
export interface DiffViewProps {
  /** Array of diff lines to display */
  lines: DiffLine[];
  /** Optional max-height in pixels (default: 384, which is 24rem) */
  maxHeight?: number;
  /** Optional CSS class name to merge with defaults */
  className?: string;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** Virtualization threshold — if more than this many lines, enable virtualizer */
const VIRTUALIZATION_THRESHOLD = 100;

/** Default max-height in pixels (24rem = 384px) */
const DEFAULT_MAX_HEIGHT = 384;

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Unified diff viewer with virtualization for large diffs.
 *
 * Renders a unified diff with:
 * - Line-number gutter (old number | new number | content)
 * - Color-coded backgrounds (red/green/neutral)
 * - Monospace font and glass-tertiary background
 * - Virtual scrolling for >100 lines
 *
 * @param lines - Array of DiffLine objects from computeUnifiedDiff
 * @param maxHeight - Max height in pixels (default 384)
 * @param className - Additional CSS classes to merge
 * @returns JSX element
 */
export function DiffView({
  lines,
  maxHeight = DEFAULT_MAX_HEIGHT,
  className,
}: DiffViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Compute old/new line number width (max digits needed)
  const maxOldLineNum = Math.max(...lines.map(l => l.oldLineNumber ?? 0));
  const maxNewLineNum = Math.max(...lines.map(l => l.newLineNumber ?? 0));
  const gutterWidth = Math.max(
    String(maxOldLineNum).length,
    String(maxNewLineNum).length,
  );

  // Determine if virtualization is needed
  const shouldVirtualize = useMemo(
    () => lines.length > VIRTUALIZATION_THRESHOLD,
    [lines.length],
  );

  // Set up virtualizer
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24, // ~24px per line (font-xs + padding)
    overscan: 10, // Render 10 lines beyond visible area for smoother scrolling
    enabled: shouldVirtualize,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Build array of line indices to render
  const renderIndices = useMemo(() => {
    if (shouldVirtualize) {
      return virtualItems.map(vi => vi.index);
    }
    return lines.map((_, i) => i);
  }, [shouldVirtualize, virtualItems, lines.length]);

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={parentRef}
      className={cn(
        'bg-[var(--glass-bg-subtle)] border border-[var(--border-primary)] rounded-lg overflow-auto',
        'font-mono text-xs',
        className,
      )}
      style={{
        maxHeight: `${maxHeight}px`,
      }}
    >
      <div
        style={{
          height: shouldVirtualize ? totalSize : undefined,
        }}
      >
        {shouldVirtualize && virtualItems.length > 0 ? (
          // Virtual rendering
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: totalSize,
            }}
          >
            {virtualItems.map(virtualItem => {
              const lineIdx = virtualItem.index;
              const line = lines[lineIdx];
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  className="absolute w-full"
                  style={{
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <DiffLineRow line={line} gutterWidth={gutterWidth} />
                </div>
              );
            })}
          </div>
        ) : (
          // Non-virtual rendering (for small diffs)
          <div>
            {renderIndices.map((lineIdx, key) => {
              const line = lines[lineIdx];
              return (
                <DiffLineRow
                  key={key}
                  line={line}
                  gutterWidth={gutterWidth}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HELPER: DiffLineRow
// ---------------------------------------------------------------------------

/**
 * Renders a single diff line with gutter and content.
 */
function DiffLineRow({
  line,
  gutterWidth,
}: {
  line: DiffLine;
  gutterWidth: number;
}) {
  const oldNumStr = line.oldLineNumber !== undefined
    ? String(line.oldLineNumber).padStart(gutterWidth, ' ')
    : ' '.repeat(gutterWidth);

  const newNumStr = line.newLineNumber !== undefined
    ? String(line.newLineNumber).padStart(gutterWidth, ' ')
    : ' '.repeat(gutterWidth);

  const bgClass =
    line.type === 'added'
      ? 'bg-[var(--diff-added-bg)]'
      : line.type === 'removed'
        ? 'bg-[var(--diff-removed-bg)]'
        : 'bg-transparent';

  const textClass =
    line.type === 'added'
      ? 'text-[var(--diff-added-text)]'
      : line.type === 'removed'
        ? 'text-[var(--diff-removed-text)]'
        : 'text-[var(--text-tertiary)]';

  return (
    <div
      className={cn(
        'flex items-start border-b border-[var(--border-primary)]',
        'px-2 py-1',
        bgClass,
      )}
    >
      {/* Old line number gutter */}
      <div className="w-fit pr-2 text-[var(--text-muted)] select-none shrink-0">
        {oldNumStr}
      </div>

      {/* New line number gutter */}
      <div className="w-fit pr-3 text-[var(--text-muted)] select-none shrink-0">
        {newNumStr}
      </div>

      {/* Content */}
      <div className={cn('flex-1 overflow-x-auto whitespace-pre-wrap break-all', textClass)}>
        {line.content}
      </div>
    </div>
  );
}
