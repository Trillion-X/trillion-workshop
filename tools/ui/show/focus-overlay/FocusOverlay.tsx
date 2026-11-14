// frontends/web/src/packages/ui/focus-overlay/FocusOverlay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical focus-mode overlay for the screen-arrangement system. Renders a
// full-viewport glass content pane via React portal. Backdrop click dismisses.
// Escape key is handled by the parent (LayoutEngine).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Renders via createPortal to document.body — escapes parent stacking contexts
// 2. Backdrop uses token-dimmed color only; large Safari backdrop-filter
//    layers render as false dark bands across the screen.
// 3. Backdrop click calls onClose — same pattern as Modal
// 4. Returns null when open is false — zero DOM footprint when closed
// 5. All styling from design tokens — ZERO hardcoded hex values
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface FocusOverlayProps {
  /** Whether the overlay is visible */
  open: boolean;
  /** Called when the backdrop is clicked to dismiss */
  onClose: () => void;
  /** Content rendered in the focused pane */
  children: React.ReactNode;
  /** Additional className for the content pane */
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Full-viewport focus overlay for maximized panes.
 *
 * Full-viewport focus overlay:
 * - Backdrop: token-dimmed click target, no fullscreen blur
 * - Content frame: same glass-surface primitive as arranged containers
 *
 * @example
 * ```tsx
 * <FocusOverlay open={isMaximized} onClose={handleExit}>
 *   {renderContainer(maximizedContainerId)}
 * </FocusOverlay>
 * ```
 */
export function FocusOverlay({ open, onClose, children, className }: FocusOverlayProps) {
  if (!open) return null;

  return createPortal(
    <div data-focus-overlay-root className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        data-focus-overlay-backdrop
        className="absolute inset-0 bg-[var(--glass-overlay-background)]"
        onClick={onClose}
      />
      <div
        data-focus-overlay-pane
        className={cn(
          'glass-surface relative m-6 flex flex-col overflow-hidden text-[var(--text-primary)]',
          'w-[calc(100%-3rem)] h-[calc(100%-3rem)]',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
