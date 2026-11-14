// frontends/web/src/packages/ui/tooltip/Tooltip.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical themed tooltip component for the Bitfield Studio.
// Replaces native browser `title` attributes with a styled, glassmorphism
// tooltip rendered via Radix Tooltip with Portal. Supports an optional
// keyboard shortcut displayed to the right of the label text.
//
// Uses glass-popover composite via portal rendering — backdrop-filter
// composites against the full page background, not the parent container.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Portal rendering via Radix — backdrop-filter composites correctly
// 2. The tooltip surface from design system tokens (Card variant `tooltip`: the worn look's popover surface, ink and font)
// 3. Optional keyboard shortcut rendered via Kbd component
// 4. Wraps children as trigger — drop-in replacement for title= attribute
// 5. No raw HTML — uses Card, Text, Kbd from ui/
// 6. Accessible: Radix describes the focused trigger with the tooltip label
// 7. Delayed by one second for both pointer hover and keyboard focus
// 8. Never repeats its trigger: a label the trigger's own text already shows,
//    with no shortcut or trailing detail, never opens (`titleRepeatsLabel`)
// 9. Never under the pointer: opens above its trigger by default and flips
//    below only when there is no room (`TOOLTIP_PLACEMENT`, shared with the
//    title delegate)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { Card } from '../card/Card';
import { Text } from '../text/Text';
import { Kbd } from '../kbd/Kbd';
import { Container } from '../container/container';
import { TOOLTIP_PLACEMENT, TOOLTIP_TRIGGER_ATTRIBUTE, titleRepeatsLabel } from './title-tooltips';

/** Prevents shared Button from wrapping a button already owned by this tooltip. */
export const InsideTooltipContext = React.createContext(false);

// ---------------------------------------------------------------------------
// STYLE CONSTANTS
// ---------------------------------------------------------------------------

// Physics-level positioning for the portal content.
const CONTENT_STYLE: React.CSSProperties = {
  zIndex: 50,
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface TooltipProps {
  /** Tooltip label text */
  label: string;
  /** Optional keyboard shortcut displayed to the right (e.g. "⌘F", "Esc") */
  shortcut?: string;
  /** Optional non-interactive detail shown after the label. */
  trailing?: React.ReactNode;
  /** Which side the tooltip appears on (default: above, so the pointer never covers it) */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Offset from the trigger element in pixels */
  sideOffset?: number;
  /** Delay in ms before showing on hover or keyboard focus (default: 1000ms) */
  delayDuration?: number;
  /** The trigger element(s) */
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Themed tooltip — drop-in replacement for native `title` attributes.
 *
 * The delayed tooltip is available from pointer hover and keyboard focus.
 * Radix attaches the visible tooltip as the trigger's accessible description.
 *
 * @example
 * ```tsx
 * // Simple label
 * <Tooltip label="Filter by CLI">
 *   <Button variant="ghost" size="icon">
 *     <Icon icon={Filter} size="sm" />
 *   </Button>
 * </Tooltip>
 *
 * // With keyboard shortcut
 * <Tooltip label="Search" shortcut="⌘K">
 *   <Button variant="ghost" size="icon">
 *     <Icon icon={Search} size="sm" />
 *   </Button>
 * </Tooltip>
 * ```
 */
export function Tooltip({
  label,
  shortcut,
  trailing,
  side = TOOLTIP_PLACEMENT.side,
  sideOffset = TOOLTIP_PLACEMENT.offset,
  delayDuration = 1000,
  children,
}: TooltipProps) {
  // A tooltip adds something the trigger does not already show: a label its
  // own text already says, with no shortcut or detail, is never opened.
  const triggerRef = React.useRef<HTMLElement>(null);
  const [open, setOpen] = React.useState(false);
  const onOpenChange = React.useCallback((next: boolean) => {
    const trigger = triggerRef.current;
    if (next && !shortcut && !trailing && trigger && titleRepeatsLabel(trigger, label)) return;
    setOpen(next);
  }, [label, shortcut, trailing]);
  return (
    <InsideTooltipContext.Provider value>
      <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={0}>
        <RadixTooltip.Root open={open} onOpenChange={onOpenChange}>
          <RadixTooltip.Trigger asChild ref={triggerRef} {...{ [TOOLTIP_TRIGGER_ATTRIBUTE]: '' }}>
            {children}
          </RadixTooltip.Trigger>
          <RadixTooltip.Portal>
            <RadixTooltip.Content
              side={side}
              sideOffset={sideOffset}
              collisionPadding={TOOLTIP_PLACEMENT.collisionPadding}
              style={CONTENT_STYLE}
              asChild
            >
              <Card variant="tooltip" padding="none" style={{ padding: '8px 12px', maxWidth: 'min(320px, var(--radix-tooltip-content-available-width, calc(100vw - 16px)))', overflowWrap: 'anywhere' }}>
                <Container layout="horizontal" gap="sm" padding="none" alignItems="center">
                  <Text variant="body-xs" color="default" leading="tight">{label}</Text>
                  {shortcut && <Kbd size="sm">{shortcut}</Kbd>}
                  {trailing}
                </Container>
              </Card>
            </RadixTooltip.Content>
          </RadixTooltip.Portal>
        </RadixTooltip.Root>
      </RadixTooltip.Provider>
    </InsideTooltipContext.Provider>
  );
}
