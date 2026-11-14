// packages/ui/show/keyboard-shortcuts/ShortcutSheet.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A domain-blind "keyboard shortcuts" cheat-sheet modal. Given a catalog of
// GROUPS (each a heading + rows of `{ label, keys }`), it renders the canonical
// reference layout — a centered dialog titled by the caller, with the groups in
// a responsive multi-column grid, each row showing a human label on the left and
// its keycaps (one <Kbd> per key) on the right.
//
// It is BLIND: it knows nothing about what any shortcut DOES. It receives only
// `{ heading, label, keys }` strings and renders them. There is no handler, no
// dispatch, no domain vocabulary. The owner package supplies the catalog DATA and
// owns the actual key handlers. Drop in ANY catalog and this component is
// unchanged (the deletion test). This is the ui-stays-blind catalog pattern: the
// shared primitive sees a descriptive shape; meaning lives in the feature DATA.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. BLIND: props are `{ open, onClose, title, groups }` — no behavior, no
//    enumeration of shortcut identities. `keys` are opaque display tokens.
// 2. COMPOSED: built ONLY from shared primitives (FloatingPanel, Text, Kbd). No raw
//    styled chrome beyond layout, no new design tokens.
// 3. FloatingPanel owns close (Escape / close button) — this component adds none.
// 4. One <Kbd> per key token, in order — a combo (⌘ then D) is multiple keys.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Text } from '../text';
import { Kbd } from '../kbd';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';

// ---------------------------------------------------------------------------
// TYPES — the descriptive catalog shape (DATA). The owner package builds this.
// ---------------------------------------------------------------------------

/** One shortcut: a human label + the display tokens of its key combo. */
export interface ShortcutRow {
  readonly label: string;
  /** Display tokens, one per key — e.g. ['⌘', 'D'] or ['⇧', '1']. Rendered in order. */
  readonly keys: readonly string[];
}

/** A titled group of shortcuts — e.g. "Edit", "Arrange". */
export interface ShortcutGroup {
  readonly heading: string;
  readonly rows: readonly ShortcutRow[];
}

export interface ShortcutSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Dialog title — e.g. "Keyboard shortcuts". */
  readonly title?: string;
  readonly groups: readonly ShortcutGroup[];
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ShortcutSheet({ open, onClose, title = 'Keyboard shortcuts', groups }: ShortcutSheetProps) {
  return (
    <FloatingPanel open={open} onClose={onClose} title={title} width={672}>
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.heading} className="min-w-0">
            <Text variant="heading-xs" color="subtle">
              {group.heading}
            </Text>
            <div className="mt-2 flex flex-col">
              {group.rows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 py-1.5">
                  <Text variant="body-xs">{row.label}</Text>
                  <div className="flex shrink-0 items-center gap-1">
                    {row.keys.map((k, i) => (
                      <Kbd key={`${row.label}-${i}-${k}`} size="sm">
                        {k}
                      </Kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </FloatingPanel>
  );
}
