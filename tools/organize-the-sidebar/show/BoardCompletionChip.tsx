// packages/group/show/BoardCompletionChip.tsx
//
// The whole-board CARD-EQUAL completion readout chip: "✓ 6/10 · 62%" — how many cards are done and the
// mean completion across every card that tracks progress. The board-level sibling of the checklist-steps
// (☑) and metric-goals (◎) chips, but counting CARDS (metric OR checklist, one vote each). Blind: it
// renders the {complete, tracked, avgPct} the `boardCompletion` leaf computes (L090).

import * as React from 'react';
import { Text } from '../../ui/index.ts';
import type { BoardCompletion } from '../read-data/board-completion.ts';

/** Renders the card-completion chip. The caller only mounts it when `tracked > 0` (else no readout). */
export function BoardCompletionChip({ complete, tracked, avgPct }: BoardCompletion): React.ReactElement {
  return (
    <Text variant="body-sm" tone="muted" aria-label={`Board cards ${complete} of ${tracked} complete, ${avgPct}% average`}>
      {`✓ ${complete}/${tracked} · ${avgPct}%`}
    </Text>
  );
}
