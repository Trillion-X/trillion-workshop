// packages/group/show/SelectionCombineBar.tsx
//
// The pin-and-COMBINE bar — the product surface for the selection set-algebra (b187). Pin the current selection,
// then combine a new selection with it using human-language ops (COMBINE_ACTIONS). Stateless: the board owns
// {selected, pinned}; this renders "Pin selection" (or "N pinned" + combine rows + "Unpin"), calling the board
// back. Names no specific op (L090) — the combine rows fold COMBINE_ACTIONS; the combine buttons only appear
// once a set is pinned (L118 — no dead rows). Completes the selection family's product surfacing (b188 + this).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Container, Text } from '../../ui';
import { COMBINE_ACTIONS, combineWithPinned } from 'trillion-workshop/tools/organize-the-sidebar/show/selection-combine.ts';

export interface SelectionCombineBarProps {
  readonly selectedIds: readonly string[];
  /** The pinned set, or null when nothing is pinned. */
  readonly pinnedIds: readonly string[] | null;
  readonly onPin: () => void;
  readonly onUnpin: () => void;
  /** Called with the NEW selection when a combine op runs (current combined with pinned). */
  readonly onCombine: (ids: string[]) => void;
}

/** Render the pin control and, once a set is pinned, the human-language combine rows. Nothing to pin (empty
 *  selection) and nothing pinned → just a disabled-looking hint via the Pin button state. */
export function SelectionCombineBar({ selectedIds, pinnedIds, onPin, onUnpin, onCombine }: SelectionCombineBarProps) {
  return (
    <Container layout="vertical" gap="xs" padding="sm" aria-label="Combine selections">
      <Text variant="label">Combine</Text>
      {pinnedIds === null ? (
        <Button variant="ghost" size="sm" aria-label="Pin selection" disabled={selectedIds.length === 0} onClick={onPin}>
          Pin selection
        </Button>
      ) : (
        <Container layout="vertical" gap="xs">
          <Container layout="horizontal" gap="xs" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="body-sm">{pinnedIds.length} pinned</Text>
            <Button variant="ghost" size="sm" aria-label="Unpin" onClick={onUnpin}>Unpin</Button>
          </Container>
          {COMBINE_ACTIONS.map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              size="sm"
              aria-label={a.label}
              onClick={() => onCombine(combineWithPinned(selectedIds, pinnedIds, a.op))}
            >
              {a.label}
            </Button>
          ))}
        </Container>
      )}
    </Container>
  );
}
