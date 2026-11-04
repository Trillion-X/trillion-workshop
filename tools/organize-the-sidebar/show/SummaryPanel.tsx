// packages/group/show/SummaryPanel.tsx
//
// The "Overview" lens panel — the board's vital signs at a glance: a read-only list of stat rows (Cards, Words,
// With a due date, Goals complete, Unconnected, …) folded from `summaryStatRows` (board-summary.ts). BLIND
// (L090): it iterates the DATA rows and draws label-left / value-right; a new stat is one push in the builder,
// zero panel code. Read-only by design — distinct from Board health (a hygiene SCORE + things to fix) and
// Breakdown (per-facet distribution you click into): this answers "how big is this board and how much is done?"
// in one look. Non-zero-omission lives in the builder, so a plain board shows just Cards + Words (no filler).
import { Button, Card, Container, Text } from '../../ui';
import type { SummaryStat } from '../read-data/board-summary';

export interface SummaryPanelProps {
  readonly rows: readonly SummaryStat[];
  readonly onClose: () => void;
}

export function SummaryPanel({ rows, onClose }: SummaryPanelProps): JSX.Element {
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 220, maxWidth: 300 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Overview</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close overview panel">Close</Button>
        </Container>
        <Container layout="vertical" gap="xs">
          {rows.map((r) => (
            <Container key={r.key} layout="horizontal" gap="sm" alignItems="center" style={{ justifyContent: 'space-between' }} aria-label={`${r.label}: ${r.value}`}>
              <Text variant="body-sm">{r.label}</Text>
              <Text variant="body-sm" weight="semibold">{r.value}</Text>
            </Container>
          ))}
        </Container>
      </Container>
    </Card>
  );
}
