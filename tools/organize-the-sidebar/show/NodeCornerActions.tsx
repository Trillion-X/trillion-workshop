// packages/group/show/NodeCornerActions.tsx
// The interactive bottom-left node chips: branch collapse caret, open-link, open-board-link, and what a source card
// offers to do to its record.

import React from 'react';
import { Button, Icon } from '../../ui';
import { AppWindow, ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { linkHost } from './item-link';
import { boardLinkLabel } from './item-board-link';

export interface NodeCornerActionsProps {
  /** #163 — present when the node roots a connector subtree; drives the caret. */
  branchToggle?: { collapsed: boolean; hiddenCount: number };
  onToggleBranch: (collapse: boolean) => void;
  /** The item's `extra.href` (absent → no link chip). */
  href: string | null;
  onOpenLink: (href: string) => void;
  /** #218 — the LIVE-resolved linked board's title (absent → no board chip). */
  boardLinkTitle: string | null;
  onOpenBoardLink: () => void;
  /** What a source card offers to do to its record (board-source.ts `sourceActions`), each pressed by its id. */
  actions?: ReadonlyArray<{ id: string; label: string }>;
  onAction?: (id: string) => void;
}

/** Returns null when no chip applies, so the CanvasNode gets no empty overlay. */
export function NodeCornerActions({
  branchToggle,
  onToggleBranch,
  href,
  onOpenLink,
  boardLinkTitle,
  onOpenBoardLink,
  actions = [],
  onAction,
}: NodeCornerActionsProps): React.ReactElement | null {
  // #163 — a node with a connector subtree shows a one-click collapse/expand
  // caret (XMind/MindNode/FigJam canon): folds the whole branch via the #162
  // `setBranchHidden` engine (2nd caller). Collapsed → a right-chevron + the
  // hidden count so the user knows what's behind it; expanded → a down-chevron.
  const caret = branchToggle ? (
    <Button
      key="branch-toggle"
      variant="secondary"
      size="sm"
      aria-label={branchToggle.collapsed ? `Expand branch (${branchToggle.hiddenCount} hidden)` : 'Collapse branch'}
      title={branchToggle.collapsed ? `Expand branch (${branchToggle.hiddenCount} hidden)` : 'Collapse branch'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggleBranch(!branchToggle.collapsed);
      }}
    >
      <Icon icon={branchToggle.collapsed ? ChevronRight : ChevronDown} size="xs" />
      {branchToggle.collapsed ? ` ${branchToggle.hiddenCount}` : null}
    </Button>
  ) : null;
  const link = href ? (
    <Button
      key="open-link"
      variant="secondary"
      size="sm"
      aria-label={`Open link: ${href}`}
      title={href}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpenLink(href); // #210: anchor-click, never navigates the shell frame
      }}
    >
      <Icon icon={ArrowUpRight} size="xs" /> {linkHost(href)}
    </Button>
  ) : null;
  // #218 — a node linked to ANOTHER board shows a "⧉ <board title>" chip
  // that navigates on click. The caller resolves the id against the LIVE
  // boards list, so a deleted/archived target self-heals to no chip
  // (blind, never a fake). Stops propagation so the click navigates, not drags.
  const boardLink = boardLinkTitle ? (
    <Button
      key="open-board-link"
      variant="secondary"
      size="sm"
      aria-label={`Go to board: ${boardLinkTitle}`}
      title={`Go to board: ${boardLinkTitle}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpenBoardLink();
      }}
    >
      <Icon icon={AppWindow} size="xs" /> {boardLinkLabel(boardLinkTitle)}
    </Button>
  ) : null;
  const offered = onAction ? actions.map((action) => (
    <Button
      key={`action-${action.id}`}
      variant="secondary"
      size="sm"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAction(action.id);
      }}
    >
      {action.label}
    </Button>
  )) : [];
  if (!caret && !link && !boardLink && !offered.length) return null;
  return (
    <>
      {caret}
      {link}
      {boardLink}
      {offered}
    </>
  );
}
