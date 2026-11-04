// packages/group/show/SelectionMenu.tsx
//
// The selection MENU — a BLIND renderer of `enabledSelectionActions` (selection-actions.ts) into real buttons.
// It names no specific selection op: it folds the DATA action list into sections and, on click, hands the board
// the NEW selection the action computes (`onSelect`). Adding a selection op (a new row, or a new
// BOARD_DIMENSIONS "Select same …") needs ZERO change here (L090). This is the product surface for the b184–b187
// selection family — the real "Select" menu the board mounts when items are selected.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { enabledSelectionActions } from './selection-actions';

export interface SelectionMenuProps {
  readonly items: readonly BoardItem[];
  readonly selectedIds: readonly string[];
  /** Called with the NEW selection when an action runs — the board replaces its selection with these ids. */
  readonly onSelect: (ids: string[]) => void;
}

/** Render the enabled selection actions, grouped by section, as clickable rows. Nothing enabled → nothing shown
 *  (the whole menu collapses when no selection op is meaningful, L118). Section order follows first-appearance. */
export function SelectionMenu({ items, selectedIds, onSelect }: SelectionMenuProps) {
  const actions = enabledSelectionActions(items, selectedIds);
  if (actions.length === 0) return null;
  const sections: string[] = [];
  for (const a of actions) if (!sections.includes(a.section)) sections.push(a.section);
  return (
    <Container layout="vertical" gap="sm" padding="sm" aria-label="Selection actions">
      {sections.map((section) => (
        <Container key={section} layout="vertical" gap="xs">
          <Text variant="label">{section}</Text>
          <Container layout="vertical" gap="xs">
            {actions.filter((a) => a.section === section).map((a) => (
              <Button
                key={a.id}
                variant="ghost"
                size="sm"
                aria-label={a.label}
                onClick={() => onSelect(a.run(items, selectedIds))}
              >
                {a.label}
              </Button>
            ))}
          </Container>
        </Container>
      ))}
    </Container>
  );
}
