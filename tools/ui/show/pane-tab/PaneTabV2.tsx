// frontends/web/src/packages/ui/pane-tab/PaneTabV2.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Tab trigger for screen-arrangement container headers. Clean rewrite.
//
// Click = root div onClick (works everywhere, no draggable conflicts).
// Drag = <button draggable> grip handle (same pattern as DragHandle in
//         container-header.tsx which works perfectly).
// Close = <button> X icon.
// Grip + X both appear on hover via group-hover/tab.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X, Pin, GripVertical } from 'lucide-react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// SHAPE VARIANT TYPE
// ---------------------------------------------------------------------------

export type PaneTabShape = 'pill' | 'scalloped';

// ---------------------------------------------------------------------------
// CVA VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const paneTabV2Variants = cva(
  'group/tab relative flex items-center gap-1 text-xs cursor-pointer flex-shrink-0',
  {
    variants: {
      active: {
        true: 'bg-[var(--glass-bg-active)] text-[var(--text-primary)] z-10 px-2 py-1',
        false: 'text-[var(--text-secondary)] hover:text-[var(--text-strong)] hover:bg-[var(--glass-bg-hover)] px-2 py-1',
      },
    },
    defaultVariants: {
      active: false,
    },
  }
);

// ---------------------------------------------------------------------------
// SCALLOPED SHAPE
// ---------------------------------------------------------------------------

const SCALLOP_RADIUS = '8px';

const scallopedBaseStyle: React.CSSProperties = {
  // @ts-expect-error CSS custom property
  '--r': SCALLOP_RADIUS,
  borderInline: 'var(--r) solid transparent',
};

const scallopedActiveStyle: React.CSSProperties = {
  ...scallopedBaseStyle,
  borderRadius: 'calc(2 * var(--r)) calc(2 * var(--r)) 0 0 / var(--r)',
  mask: 'radial-gradient(var(--r) at var(--r) 0, transparent 98%, #000 101%) calc(-1 * var(--r)) 100% / 100% var(--r) repeat-x, conic-gradient(#000 0 0) padding-box',
  WebkitMask: 'radial-gradient(var(--r) at var(--r) 0, transparent 98%, #000 101%) calc(-1 * var(--r)) 100% / 100% var(--r) repeat-x, conic-gradient(#000 0 0) padding-box',
};

function resolveStyle(shape: PaneTabShape, active: boolean): React.CSSProperties {
  if (shape === 'scalloped') return active ? scallopedActiveStyle : scallopedBaseStyle;
  return {};
}

function resolveShapeClass(shape: PaneTabShape, active: boolean): string {
  if (shape === 'pill') return 'rounded-lg';
  return active ? '' : 'rounded-md';
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface PaneTabV2Props extends VariantProps<typeof paneTabV2Variants> {
  title: string;
  active?: boolean;
  shape?: PaneTabShape;
  pinned?: boolean;
  closable?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onClose?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function PaneTabV2({
  title,
  active = false,
  shape = 'pill',
  pinned = false,
  closable = true,
  onClick,
  onClose,
  onDragStart,
  onDragEnd,
  className,
}: PaneTabV2Props) {
  const tabRef = React.useRef<HTMLDivElement>(null);

  return (
    <div
      ref={tabRef}
      data-tab-draggable="1"
      role="group"
      aria-label={title}
      className={cn(paneTabV2Variants({ active }), resolveShapeClass(shape, active), className)}
      style={resolveStyle(shape, active)}
      onClick={onClick}
    >
      {pinned && <Pin className="h-3 w-3 opacity-60" />}
      <span className="truncate max-w-[12rem]">{title}</span>

      {/* Close button */}
      {closable && !pinned && (
        <button
          type="button"
          data-no-drag="true"
          onClick={(e) => { e.stopPropagation(); onClose?.(e); }}
          className="pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-status-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring-color)] transition-opacity"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
