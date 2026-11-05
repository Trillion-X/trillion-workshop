// packages/group/show/RankedJumpList.tsx
//
// The generic "list board items by a metric, click to jump" panel — the shared primitive behind the
// comments triage panel AND the dot-voting ranking (and any future "most-connected / largest / newest"
// list). ONE blind list: it renders {label, note?, badge?} rows and emits onJumpTo(id); it never knows
// what the metric MEANS (L069/L090). Extracted the moment the second caller arrived (L076) — both
// panels are now DATA configs of this, so the list code lives once (L100). ui components only (L065).

import { Button, Card, Container, Text } from '../../ui/index.ts';

/** One row: an id to jump to, a bold label, an optional muted note line, and an optional trailing badge. */
export interface RankedRow {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  readonly badge?: string;
}

export interface RankedJumpListProps {
  readonly title: string;
  /** Muted line beside the title (e.g. "3 open" / "12 votes"). */
  readonly subtitle?: string;
  readonly rows: readonly RankedRow[];
  /** Shown when there are no rows (honest empty state). */
  readonly emptyText: string;
  /** Numbered steps under the empty text — the caller supplies the words; the list stays blind. */
  readonly emptySteps?: readonly string[];
  /** Verb for the row aria-label, e.g. jumpVerb "comments on" gives "Jump to comments on Idea A". Default "". */
  readonly jumpVerb?: string;
  /**
   * Embedded mode: render as a SECTION (no popover Card wrapper, no Close button) so several lists can be
   * stacked inside one parent panel (e.g. the Review surface's "Needs attention" + "On a roll"). Default
   * false = the standalone popover the other callers use, unchanged.
   */
  readonly embedded?: boolean;
  readonly onJumpTo: (id: string) => void;
  readonly onClose: () => void;
}

export function RankedJumpList({
  title,
  subtitle,
  rows,
  emptyText,
  emptySteps,
  jumpVerb,
  embedded = false,
  onJumpTo,
  onClose,
}: RankedJumpListProps): JSX.Element {
  const verb = jumpVerb ? `${jumpVerb} ` : '';
  const body = (
    <Container layout="vertical" gap="sm" style={{ minWidth: 260, maxWidth: 320 }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-md" weight="semibold">{title}</Text>
        {subtitle ? <Text variant="body-sm" tone="muted">{subtitle}</Text> : null}
        {embedded ? null : (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Close ${title} panel`}>Close</Button>
        )}
      </Container>

      {rows.length === 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="body-sm" tone="muted">{emptyText}</Text>
          {(emptySteps ?? []).map((step, i) => (
            <Text key={step} variant="body-sm">{`${i + 1}. ${step}`}</Text>
          ))}
        </Container>
      ) : (
        rows.map((r) => (
          <Button
            key={r.id}
            variant="secondary"
            size="sm"
            onClick={() => onJumpTo(r.id)}
            aria-label={`Jump to ${verb}${r.label}`}
          >
            <Container layout="vertical" gap="xs" style={{ width: '100%' }}>
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Text variant="body-sm" weight="semibold">{r.label}</Text>
                {r.badge ? <Text variant="caption" tone="muted">{r.badge}</Text> : null}
              </Container>
              {r.note ? <Text variant="body-sm" tone="muted">{r.note}</Text> : null}
            </Container>
          </Button>
        ))
      )}
    </Container>
  );
  return embedded ? body : <Card variant="popover" padding="md">{body}</Card>;
}
