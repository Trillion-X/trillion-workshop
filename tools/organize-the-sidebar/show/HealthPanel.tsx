// packages/group/show/HealthPanel.tsx
//
// The "Board health" lens (b223) — a scored board-HYGIENE dashboard: the 0–100 health score + grade, then one
// clickable row per hygiene signal that flagged something (disconnected / untagged / ambiguous-title / unlinked-
// mention / duplicate-connector / overlong cards). Clicking a signal selects + frames the cards it flagged, so
// the score is actionable, not vanity. Blind over `board-health` (b: the DATA signal catalog + reducer) — a new
// signal is one DATA row, ZERO change here (L069/L090). Distinct from Review (card-level risk/momentum) and
// Tidiness (spatial overlaps): this is board-level STRUCTURAL hygiene. ui only (L065).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Badge, Button, Card, Container, Text } from '../../ui/index.ts';
import type { BoardHealth, HealthSignalDetail } from '../read-data/board-health.ts';

export interface HealthPanelProps {
  /** The board's 0–100 score + grade (from `boardHealth`). */
  readonly health: BoardHealth;
  /** Per-signal detail with the affected card ids (from `healthSignalDetails`) — drives the jumpable issue rows. */
  readonly details: readonly HealthSignalDetail[];
  /** Select + frame the cards a signal flagged. */
  readonly onJumpIssue: (ids: readonly string[]) => void;
  readonly onClose: () => void;
}

export function HealthPanel({ health, details, onJumpIssue, onClose }: HealthPanelProps): JSX.Element {
  // Only signals that are applicable AND actually flagged something are worth a row (L118 — a clean check adds no
  // action). Rendered worst-first so the biggest hygiene problem is at the top.
  const issues = details
    .filter((d) => d.applicable && d.affected.length > 0)
    .sort((a, b) => b.ratio - a.ratio);
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 260, maxWidth: 320 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Board health</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close board health panel">Close</Button>
        </Container>

        <Container layout="horizontal" gap="sm" alignItems="center" aria-label={`Health score ${health.score ?? 'none'} out of 100 — ${health.grade}`}>
          <Text variant="heading-lg" weight="bold">{health.score ?? '—'}</Text>
          <Badge variant="neutral" size="sm">{health.grade}</Badge>
        </Container>

        {issues.length === 0 ? (
          <Text variant="body-sm">Nothing to fix — every hygiene check is clean.</Text>
        ) : (
          <Container layout="vertical" gap="xs">
            <Text variant="label">What to improve</Text>
            {issues.map((d) => (
              <Button
                key={d.id}
                variant="ghost"
                size="sm"
                aria-label={`Select the ${d.affected.length} cards flagged by ${d.label}`}
                onClick={() => onJumpIssue(d.affected)}
              >
                {`${d.label} · ${d.affected.length}`}
              </Button>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
}
