// frontends/web/src/packages/ui/pane-tab/PaneTab.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical tab trigger for the screen-arrangement container header. Handles active/
// inactive states, close button, and drag support. Two visual modes:
//   - "pill" (default): rounded-lg button-style, matches Button ghost design
//   - "scalloped": Safari-style curved mask at the bottom
// All visual states flow through CVA variants — feature code never touches
// colors or styling directly.
//
// =============================================================================
// CLICK + DRAG ARCHITECTURE (L063 structural elimination)
// =============================================================================
//
// The draggable root preserves HTML5 tab reordering. The title button handles
// activation and the close button is a separate accessible action. This avoids
// invalid nested buttons while keeping pointer and keyboard use intact.
//
// DO NOT add onPointerDownCapture/onMouseDownCapture with stopPropagation() —
// this was proven to prevent HTML5 drag initiation on the element.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Two shape variants: pill (default) and scalloped — switchable via prop
// 2. Active state styling matches Button ghost active (bg-[var(--glass-bg-active)], text-white)
// 3. Inactive state uses ghost-level hover (white/8 bg, white/90 text)
// 4. Close takes no room until wanted: it opens beside the title when the tab is
//    the active one, pointed at (or tapped: the finger's hover, ui touch-equivalence),
//    or holds focus, drawn with the one close look (screen-look close-control.css).
//    No JS toggle.
// 5. Root is a draggable group; tab and close actions are sibling buttons
// 6. All colors from design tokens — ZERO hardcoded hex values
// 7. select-none on root prevents text selection interfering with drag
// 8. the title button keeps normal keyboard activation; drag remains on root
// 9. NO capture-phase stopPropagation — it blocks HTML5 DnD initiation
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X, Pin } from 'lucide-react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// SHAPE VARIANT TYPE
// ---------------------------------------------------------------------------

export type PaneTabShape = 'pill' | 'scalloped';

// ---------------------------------------------------------------------------
// CVA VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const paneTabVariants = cva(
  // Base: shared across all states. select-none prevents text drag mode so element drag works.
  'group/tab relative flex items-center gap-1 text-xs cursor-pointer flex-shrink-0 select-none',
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
// PILL SHAPE — default. Button-style rounded-lg, all corners.
// ---------------------------------------------------------------------------

const pillActiveStyle: React.CSSProperties = {};
const pillInactiveStyle: React.CSSProperties = {};

// ---------------------------------------------------------------------------
// SCALLOPED SHAPE — Safari-style curved tab with mask at bottom.
// Pure geometry (Physics), expressed as CSS custom properties.
// ---------------------------------------------------------------------------

const SCALLOP_RADIUS = '8px';

/** Both active and inactive scalloped tabs reserve the same border space to prevent width shift. */
const scallopedBaseStyle: React.CSSProperties = {
  // @ts-expect-error CSS custom property
  '--r': SCALLOP_RADIUS,
  borderInline: 'var(--r) solid transparent',
};

/** Scalloped active tab adds mask + rounded top. */
const scallopedActiveStyle: React.CSSProperties = {
  ...scallopedBaseStyle,
  borderRadius: 'calc(2 * var(--r)) calc(2 * var(--r)) 0 0 / var(--r)',
  mask: 'radial-gradient(var(--r) at var(--r) 0, transparent 98%, #000 101%) calc(-1 * var(--r)) 100% / 100% var(--r) repeat-x, conic-gradient(#000 0 0) padding-box',
  WebkitMask: 'radial-gradient(var(--r) at var(--r) 0, transparent 98%, #000 101%) calc(-1 * var(--r)) 100% / 100% var(--r) repeat-x, conic-gradient(#000 0 0) padding-box',
};

// ---------------------------------------------------------------------------
// STYLE RESOLVER — picks the right inline style for shape + active state
// ---------------------------------------------------------------------------

function resolveStyle(shape: PaneTabShape, active: boolean): React.CSSProperties {
  if (shape === 'scalloped') return active ? scallopedActiveStyle : scallopedBaseStyle;
  return active ? pillActiveStyle : pillInactiveStyle;
}

/** Extra classNames per shape — pill gets rounded-lg on both states, scalloped only on inactive. */
function resolveShapeClass(shape: PaneTabShape, active: boolean): string {
  if (shape === 'pill') return 'rounded-[var(--radius-control)]';
  return active ? '' : 'rounded-[var(--radius-control)]';
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface PaneTabProps extends VariantProps<typeof paneTabVariants> {
  /** Tab display title */
  title: string;
  /** Drawn before the title, for example what kind of thing the tab shows. */
  leading?: React.ReactNode;
  /** Whether this tab is the active/selected tab */
  active?: boolean;
  /** Visual shape: "pill" (default, button-like) or "scalloped" (Safari-style curves) */
  shape?: PaneTabShape;
  /** Whether the tab is pinned (shows pin icon instead of close) */
  pinned?: boolean;
  /** Whether the tab can be closed (shows X button on hover) */
  closable?: boolean;
  /** Click handler — activates this tab */
  onClick?: (e: React.MouseEvent) => void;
  /** Close handler */
  onClose?: (e: React.MouseEvent) => void;
  /** Drag start handler */
  onDragStart?: (e: React.DragEvent) => void;
  /** Drag end handler */
  onDragEnd?: (e: React.DragEvent) => void;
  /** Context menu handler */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Warm-before-click hook; the tab itself does not know what warm means. */
  onPointerEnter?: (e: React.PointerEvent) => void;
  /** Keyboard parity for pointer warm-up. */
  onFocus?: (e: React.FocusEvent) => void;
  /** Drag-over handler — call preventDefault to mark this tab a valid drop target (reorder). */
  onDragOver?: (e: React.DragEvent) => void;
  /** Drop handler — fires when another tab is dropped onto this one (reorder). */
  onDrop?: (e: React.DragEvent) => void;
  /**
   * Opaque region handle stamped as `data-node-ref` on the tab's root element.
   * Lets a delegated surface-level contextmenu router open this tab's node menu
   * without the host wiring a per-tab handler. The tab never interprets it.
   */
  nodeRef?: string;
  /**
   * Wraps only the title button, never the close button: a caller hangs a hover
   * card on the tab's name this way (the card must not open over the close).
   */
  wrapTitle?: (title: React.ReactElement<Record<string, unknown>>) => React.ReactElement;
  /** Extra className for layout positioning only */
  className?: string;
  testId?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical tab trigger for pane/container headers.
 *
 * Root is draggable for HTML5 DnD. Title and close are separate buttons so
 * both actions remain keyboard accessible without nested interactive markup.
 * Click and drag both work from anywhere on the tab.
 *
 * @example
 * ```tsx
 * <PaneTab title="Chat" active onClick={...} onClose={...} />
 * <PaneTab title="Dashboard" onDragStart={...} onDragEnd={...} />
 * ```
 */
export function PaneTab({
  title,
  leading,
  active = false,
  shape = 'pill',
  pinned = false,
  closable = true,
  onClick,
  onClose,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onPointerEnter,
  onFocus,
  onDragOver,
  onDrop,
  nodeRef,
  wrapTitle,
  className,
  testId,
}: PaneTabProps) {
  const titleButton = (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onFocus={onFocus}
      className="min-w-0 max-w-[12rem] flex-1 truncate border-0 bg-transparent p-0 text-left font-[inherit] text-inherit outline-none"
    >
      {title}
    </button>
  );
  return (
    <div
      draggable
      data-tab-draggable="1"
      data-node-ref={nodeRef}
      data-testid={testId}
      role="group"
      aria-label={title}
      className={cn(paneTabVariants({ active }), resolveShapeClass(shape, active), className)}
      style={resolveStyle(shape, active)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
    >
      {pinned && <Pin className="h-3 w-3 opacity-60 pointer-events-none" />}
      {leading}
      {wrapTitle ? wrapTitle(titleButton) : titleButton}

      {/* Separate action button keeps close reachable by pointer and keyboard. */}
      {closable && !pinned && (
        <button
          type="button"
          data-no-drag="true"
          onClick={(e) => { e.stopPropagation(); onClose?.(e); }}
          className={cn(
            'close-control inline-flex h-5 shrink-0 items-center justify-center overflow-hidden transition-[width,opacity,margin] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring-color)]',
            active
              ? 'w-5 opacity-100'
              : '-ml-1 w-0 opacity-0 pointer-events-none group-hover/tab:ml-0 group-hover/tab:w-5 group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto group-focus-within/tab:ml-0 group-focus-within/tab:w-5 group-focus-within/tab:opacity-100 group-focus-within/tab:pointer-events-auto focus-visible:ml-0 focus-visible:w-5 focus-visible:opacity-100 focus-visible:pointer-events-auto',
          )}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
