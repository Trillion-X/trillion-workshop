// packages/group/show/CollectionBasketBar.tsx
//
// The COLLECTION BASKET summary bar — the user-facing surface of the cross-board collection
// basket (R5). Shows how much has been accumulated ("N items from M boards") and offers Save
// (merge the basket into one collection) + Clear. Blind: it takes counts + callbacks as DATA,
// never touching the basket store itself (the panel owns that). Renders nothing when empty
// (L118 — no filler when there's nothing to collect). Composed from ui primitives (L065).

import React from 'react';
import { Container, Text, Button } from '../../ui/index.ts';

/** "N items from M boards" — the basket's plain-language summary. Pure, singular-aware. */
export function basketSummaryLabel(itemCount: number, boardCount: number): string {
  const items = itemCount === 1 ? '1 item' : `${itemCount} items`;
  const boards = boardCount === 1 ? '1 board' : `${boardCount} boards`;
  return `${items} from ${boards}`;
}

export interface CollectionBasketBarProps {
  readonly itemCount: number;
  readonly boardCount: number;
  readonly onSave: () => void;
  readonly onClear: () => void;
  readonly onShare?: () => void;
}

export function CollectionBasketBar({ itemCount, boardCount, onSave, onClear, onShare }: CollectionBasketBarProps): JSX.Element | null {
  if (itemCount <= 0) return null; // empty basket → nothing to show
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" aria-label="Collection basket">
      <Text variant="body" weight="medium">Collection basket</Text>
      <Text variant="body" color="muted">{basketSummaryLabel(itemCount, boardCount)}</Text>
      <Button variant="primary" size="sm" onClick={onSave} aria-label="Save collection from basket">
        Save collection
      </Button>
      {onShare ? (
        <Button variant="secondary" size="sm" onClick={onShare} aria-label="Share basket as one link">
          Share as link
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear collection basket">
        Clear
      </Button>
    </Container>
  );
}

CollectionBasketBar.displayName = 'CollectionBasketBar';
