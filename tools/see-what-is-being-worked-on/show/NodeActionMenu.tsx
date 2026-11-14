// packages/workflow-canvas/show/NodeActionMenu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The inspector header's "…" overflow menu — the Lindy flow-editor anatomy
// where per-node actions (Rename, Delete, …) collapse into a single trailing
// menu instead of scattering buttons down the panel body. (Reference: Lindy
// node menu — "…" opens Rename / Duplicate / Delete; the connections row uses
// the identical trailing-"…" → Reconnect / Share / Remove popover.)
//
// =============================================================================
// WHY THIS IS THE L069 GENERATIVE PRIMITIVE (not a fixed menu)
// =============================================================================
//
// This component is BLIND. It does not know "rename" from "delete" — it renders
// whatever action list the caller hands it. Each NodeMenuAction is self-
// describing data: a label, and where the row opts in, a glyph, a danger tone,
// and a two-step confirm. The menu switches only on those generic, closed UI
// properties, never on a node-kind or action-name word. Adding a new per-node
// action is ONE row in the caller's actions array — zero edits here (L090:
// self-describing data, generic handler). The two-step confirm is itself a
// generic affordance any destructive item opts into via `confirm`, so the menu
// never learns the word "delete" to know a click is dangerous.
//
// SSOT: this is now a thin adapter over the shared ui ActionMenu (the design
// that started here was promoted into packages/ui/show/action-menu), so the
// canvas and every other app draw one menu: icon, label, shortcut hint, tone,
// two-step confirm. This file invents no menu rendering.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { ActionMenu, type ActionShortcut } from '../../ui/show/action-menu';

/**
 * One self-describing menu row. The menu reads only these generic fields — it
 * never branches on what the action "means".
 */
export interface NodeMenuAction {
  /** Stable identity for the row (also keys the confirm state). */
  id: string;
  /** Human label shown in the row. */
  label: string;
  /** Leading glyph for the row. Required: the shared menu never draws a plain-text row. */
  icon: LucideIcon;
  /** Tints the row destructive-red. Pure presentation — not "is delete". */
  danger?: boolean;
  /**
   * When set, selecting the row swaps it in place for a two-step confirm whose
   * label reads this text. The menu stays blind to which action is
   * destructive — confirm is opt-in data, not a hard-coded delete special case.
   */
  confirm?: string;
  /** Keyboard shortcut hint for the row, when the canvas binds one. */
  shortcut?: ActionShortcut;
  /** Fired when the row (or its confirmation) is chosen. */
  onSelect: () => void;
}

export interface NodeActionMenuProps {
  /** The rows to render. Empty → the trigger is not rendered at all. */
  actions: readonly NodeMenuAction[];
  /** Accessible label for the "…" trigger button. */
  ariaLabel?: string;
  /** Force the panel open — for the offline render harness / controlled tests. */
  defaultOpen?: boolean;
}

/**
 * A trailing "…" button that opens the shared action menu. Renders nothing when
 * there are no actions, so callers pass the full candidate list and let
 * emptiness hide the affordance (no caller-side "should I show the menu?" branch).
 */
export function NodeActionMenu({
  actions,
  ariaLabel = 'More actions',
  defaultOpen = false,
}: NodeActionMenuProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(defaultOpen);
  if (actions.length === 0) return null;
  return (
    <span data-workflow-node-action-menu="true" style={{ flexShrink: 0 }}>
      <ActionMenu
        label={ariaLabel}
        open={open}
        onOpenChange={setOpen}
        items={actions.map((action) => ({
          id: action.id,
          label: action.label,
          icon: action.icon,
          tone: action.danger ? 'destructive' : undefined,
          confirm: action.confirm ? `${action.confirm}?` : undefined,
          shortcut: action.shortcut,
          group: action.danger ? 'danger' : 'actions',
        }))}
        onAction={(id) => actions.find((action) => action.id === id)?.onSelect()}
      />
    </span>
  );
}
