// packages/group/show/ReportRowSelectControl.tsx
//
// The BLIND bulk-select control for a report — turns "click ONE group" into "select every group matching a rule".
// Folds `ROW_SELECTORS` (report-row-select.ts) into a segmented picker (Highest / Above average / Below average /
// Unmeasured) + a Select button; picking a rule and pressing Select hands the caller the union of the kept rows'
// card ids. It names no selector (iterates the DATA, L090) — a new rule is one catalog row, zero code here. Self-
// hides when there are no rows to act on. Distinct from the per-row click (that grabs ONE group); this grabs the
// whole slice a rule matches (the analysis→action bridge at the set level).
import { useState } from 'react';
import { Button, Container, Text } from '../../ui';
import type { ReportRow } from '../read-data/board-report';
import { ROW_SELECTORS, reportRowSelection } from '../read-data/report-row-select';

export interface ReportRowSelectControlProps {
  readonly rows: readonly ReportRow[];
  /** Called with the deduped card ids the chosen rule keeps — the board selects that set. */
  readonly onSelect: (ids: string[]) => void;
}

export function ReportRowSelectControl({ rows, onSelect }: ReportRowSelectControlProps): JSX.Element {
  const [selectorId, setSelectorId] = useState<string>(ROW_SELECTORS[0].id);
  if (rows.length === 0) return <></>; // nothing to bulk-select
  return (
    <Container layout="vertical" gap="xs" aria-label="Bulk select groups">
      <Text variant="label">Select groups</Text>
      <Container layout="horizontal" gap="xs" style={{ flexWrap: 'wrap' }}>
        {ROW_SELECTORS.map((s) => (
          <Button
            key={s.id}
            variant={s.id === selectorId ? 'primary' : 'ghost'}
            size="sm"
            aria-label={`Rule: ${s.label}`}
            onClick={() => setSelectorId(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </Container>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Select these groups"
        onClick={() => onSelect(reportRowSelection(rows, selectorId))}
      >
        Select these
      </Button>
    </Container>
  );
}
