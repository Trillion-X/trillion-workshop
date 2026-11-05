// packages/group/show/BalancePanel.tsx
//
// The BALANCE panel — "is my board lopsided?" A per-facet evenness readout: for each facet (tag / colour / type
// / …) it shows how evenly the board's cards spread across that facet's values, and which value dominates. The
// design-signal surface for a vision board (are you over-indexed on one theme / colour?). A BLIND renderer (L090)
// of `balanceRows` — it names no facet, folds whatever rows the injected facet list produced (a facet with one
// value is dropped upstream, so no meaningless "100% dominated" row, L118). Unlike the rank/jump panels this is
// a metric dashboard, not a jump-to list. ui-only, stateless.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Badge, Button, Card, Container, Text } from '../../ui/index.ts';
import type { BalanceRow } from '../do-work/board-balance-actions.ts';

export interface BalancePanelProps {
  readonly rows: readonly BalanceRow[];
  readonly onClose: () => void;
  readonly embedded?: boolean;
  /** Select the over-represented cards for a facet — turns each row into a "select the N dominant cards" action
   *  (find what makes the board lopsided, to prune / rebalance). When omitted, rows are read-only. */
  readonly onSelectDominant?: (row: BalanceRow) => void;
}

/** The muted second line — the dominant value and its share + how many values exist. */
function shareNote(row: BalanceRow): string {
  const pct = Math.round(row.topShare * 100);
  return `top "${row.dominant}" ${pct}% · ${row.distinct} values`;
}

export function BalancePanel({ rows, onClose, embedded, onSelectDominant }: BalancePanelProps): JSX.Element {
  const body = (
    <Container layout="vertical" gap="sm" style={{ minWidth: 260, maxWidth: 340, maxHeight: '60vh', overflowY: 'auto' }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-md" weight="semibold">Diversity</Text>
        {embedded ? null : (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close diversity panel">Close</Button>
        )}
      </Container>
      {rows.length === 0 ? (
        <Text variant="body-sm" tone="muted">Tag or colour a few cards to see how evenly your board is spread.</Text>
      ) : (
        rows.map((r) => {
          const rowBody = (
            <Container layout="horizontal" gap="sm" alignItems="center" style={{ justifyContent: 'space-between', width: '100%' }}>
              <Container layout="vertical" gap="xs">
                <Text variant="body-sm" weight="semibold">{r.label}</Text>
                <Text variant="caption" tone="muted">{shareNote(r)}</Text>
              </Container>
              <Badge variant="neutral" size="sm">{r.band}</Badge>
            </Container>
          );
          return onSelectDominant ? (
            <Button
              key={r.key}
              variant="ghost"
              size="sm"
              aria-label={`Select the ${r.dominantCount} cards where ${r.label} is "${r.dominant}"`}
              onClick={() => onSelectDominant(r)}
            >
              {rowBody}
            </Button>
          ) : (
            <Container key={r.key} style={{ width: '100%' }}>{rowBody}</Container>
          );
        })
      )}
    </Container>
  );
  return embedded ? body : <Card variant="popover" padding="md">{body}</Card>;
}
