//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic three-pane inbox shell primitive: a narrow RAIL (sources / folders /
// groups) | a LIST (the items in the selected rail entry) | a DETAIL pane (the
// opened item). This is the recurring anatomy behind Intercom, Plain, GoDaddy,
// Sprout Social, and the chat surface — three panes on desktop, ONE pane at a
// time on narrow widths with back-navigation.
//
// The primitive owns ONLY browser-local layout mechanics: its default desktop
// 3-column arrangement and narrow-width single-pane selection (which of
// rail/list/detail is visible, given the viewport width and caller-owned state).
// Callers with a shared arrangement owner may use the optional render seam to
// place the same slots while keeping this primitive's responsive selection.
// Every pane's CONTENT is a caller-supplied node — this primitive contains zero
// domain vocabulary (no "conversation", "channel", "agent", "message"). A chat
// surface, a support inbox, a mail client, or a notifications center are all the
// SAME primitive configured with different slot content (L069).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The default layout is composed from ui/ primitives only (Container) — no
//    raw markup, no CSS-var literals, no domain words. The L065/L066 firewall.
// 2. Slots (rail / list / detail) are opaque React nodes. Callers put a
//    the owned sidebar in `list` and their own rail/detail content, so this
//    primitive never knows what they are.
// 3. Narrow-width pane selection is a PURE function of (width, breakpoint,
//    hasSelection, openItem) — `visiblePaneAtWidth` — so it is unit-testable
//    with zero DOM and drives identical behavior everywhere (L089: one code
//    path, environment is data).
// 4. The primitive is presentation-only: it does not own the selection STATE
//    (which rail entry / which item is open). That is caller state passed in —
//    the caller is the SSOT. The primitive only renders + emits back-navigation
//    intents.
// 5. The optional render seam supplies all caller nodes and slot
//    visibility as DATA. Callers can delegate placement to their shared owner
//    without changing this primitive's responsive selection rules.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container } from '../container';

// ============================================================================
// TYPES
// ============================================================================

/** Which single pane is shown on a narrow viewport. On wide viewports all three
 *  render together and this is unused. */
export type InboxPane = 'rail' | 'list' | 'detail';

export interface InboxThreePaneProps {
  /** Left rail content (sources / folders / groups). */
  rail: React.ReactNode;
  /** Middle list content (the items inside the selected rail entry). */
  list: React.ReactNode;
  /** Right detail content (the opened item). When nothing is open, callers
   *  typically pass an empty/hero node here. */
  detail: React.ReactNode;
  /** Current viewport width in px. Drives the narrow-vs-wide decision purely so
   *  the same logic is testable and identical across hosts (L089). */
  width: number;
  /** Below this width the shell collapses to one pane at a time. */
  narrowBreakpointPx?: number;
  /** Whether the user has selected a rail entry (so the LIST is meaningful). */
  hasSelection: boolean;
  /** Whether the user has opened an item (so the DETAIL is meaningful). */
  isItemOpen: boolean;
  /** The caller-owned meaningful pane when neither selection depth flag chooses
   *  a deeper pane. This is presentation DATA, not domain inference. */
  preferredPane?: InboxPane;
  /** On narrow widths, fires when the user navigates back one level
   *  (detail → list → rail). Callers update their own selection state. */
  onNavigateBack?: (from: InboxPane) => void;
  /** Optional caller composition seam. All slots are supplied; visibility is
   *  supplied as DATA so an owner can place them without resetting caller state. */
  renderSlots?: (state: InboxThreePaneSlots) => React.ReactNode;
  className?: string;
}

export interface InboxThreePaneSlots {
  slots: Record<InboxPane, React.ReactNode>;
  visibleSlots: readonly InboxPane[];
  hiddenSlots: readonly InboxPane[];
  wide: boolean;
  pane: InboxPane;
  onNavigateBack: () => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const DEFAULT_INBOX_NARROW_BREAKPOINT_PX = 760;

// ============================================================================
// PURE LAYOUT LOGIC (unit-testable, zero DOM)
// ============================================================================

export interface InboxPaneVisibility {
  /** True when the viewport is wide enough to show all three panes at once. */
  wide: boolean;
  /** On narrow viewports, the single pane to render. On wide, all three render
   *  and this still reports the "focused" pane for back-navigation semantics. */
  pane: InboxPane;
}

/**
 * Decide what to show, purely. On a WIDE viewport all three panes render
 * (pane = the deepest meaningful one, for back-nav semantics). On a NARROW
 * viewport exactly one pane renders, chosen by how far the user has drilled in:
 *   opened an item        -> 'detail'
 *   selected a rail entry -> 'list'
 *   otherwise             -> 'rail'
 */
export function visiblePaneAtWidth(args: {
  width: number;
  narrowBreakpointPx?: number;
  hasSelection: boolean;
  isItemOpen: boolean;
  preferredPane?: InboxPane;
}): InboxPaneVisibility {
  const breakpoint = args.narrowBreakpointPx ?? DEFAULT_INBOX_NARROW_BREAKPOINT_PX;
  const wide = args.width >= breakpoint;
  let pane: InboxPane = args.preferredPane ?? 'rail';
  if (args.isItemOpen) pane = 'detail';
  else if (args.hasSelection) pane = 'list';
  return { wide, pane };
}

/** The pane one level shallower than `pane` (for narrow-width back-nav). The
 *  rail is the root and has no shallower pane (returns null). */
export function shallowerPane(pane: InboxPane): InboxPane | null {
  if (pane === 'detail') return 'list';
  if (pane === 'list') return 'rail';
  return null;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InboxThreePane({
  rail,
  list,
  detail,
  width,
  narrowBreakpointPx,
  hasSelection,
  isItemOpen,
  preferredPane,
  onNavigateBack,
  renderSlots,
  className,
}: InboxThreePaneProps) {
  const { wide, pane } = visiblePaneAtWidth({ width, narrowBreakpointPx, hasSelection, isItemOpen, preferredPane });
  const visibleSlots: readonly InboxPane[] = wide ? ['rail', 'list', 'detail'] : [pane];
  const hiddenSlots: readonly InboxPane[] = wide ? [] : (['rail', 'list', 'detail'] as const).filter(slot => slot !== pane);
  const shallower = shallowerPane(pane);
  const handleBack = () => {
    if (shallower && onNavigateBack) onNavigateBack(pane);
  };

  if (renderSlots) return <>{renderSlots({
    slots: { rail, list, detail }, visibleSlots, hiddenSlots, wide, pane, onNavigateBack: handleBack,
  })}</>;

  if (wide) {
    // Three columns side by side. The rail and list are intrinsically sized by
    // their own content (rail/list are CollapsiblePanel or the owned sidebar, which
    // own their width); the detail pane is the flexible hero.
    return (
      <Container
        layout="horizontal"
        gap="none"
        padding="none"
        flex={1}
        minHeight="0"
        className={className}
      >
        {rail}
        {list}
        <Container layout="vertical" flex={1} minHeight="0" padding="none" overflow="hidden">
          {detail}
        </Container>
      </Container>
    );
  }

  // Narrow: exactly one pane. Back-navigation is the caller's to wire via the
  // pane content (e.g. a back button in the detail header calls onNavigateBack).
  return (
    <Container
      layout="vertical"
      gap="none"
      padding="none"
      flex={1}
      minHeight="0"
      className={className}
      data-inbox-pane={pane}
      data-inbox-back-target={shallower ?? ''}
      onKeyDown={(e: React.KeyboardEvent) => {
        // Escape navigates back one level on narrow viewports.
        if (e.key === 'Escape') handleBack();
      }}
    >
      {pane === 'rail' && rail}
      {pane === 'list' && list}
      {pane === 'detail' && detail}
    </Container>
  );
}
