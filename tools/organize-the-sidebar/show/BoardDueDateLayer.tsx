// packages/group/show/BoardDueDateLayer.tsx
//
// The at-a-glance surface for the due-date primitive: a relative-time badge on every item that HAS a
// due date ("in 3 days" / "Yesterday"), tinted by urgency (overdue red, today/soon amber), click to
// open the item's date picker. Generic + DATA-driven — it renders whatever badges it is handed and
// never names an item; the mount resolves each item to a screen rect + computes the relative readout.
// L065: ui only; the badge is a positioned Container because its coordinate is dynamic.

import { Button, Container, Text } from '../../ui';
import type { DueUrgency } from '../read-data/board-due-date';

export interface DueBadgeRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One badge: an item's screen rect + its relative-time label + urgency (drives the tint). */
export interface DueBadge {
  readonly memberId: string;
  readonly rect: DueBadgeRect;
  readonly label: string;
  readonly urgency: DueUrgency;
}

export interface BoardDueDateLayerProps {
  readonly badges: readonly DueBadge[];
  readonly onOpen: (memberId: string) => void;
}

/** Urgency → a CSS color for the badge text/border. Overdue reads red, today/soon amber, else muted. */
function urgencyColor(urgency: DueUrgency): string {
  if (urgency === 'overdue') return 'var(--color-danger, #dc2626)';
  if (urgency === 'today' || urgency === 'soon') return 'var(--color-warning, #d97706)';
  return 'var(--text-muted, #64748b)';
}

export function BoardDueDateLayer({ badges, onOpen }: BoardDueDateLayerProps): JSX.Element {
  return (
    <>
      {badges.map((badge) => {
        const color = urgencyColor(badge.urgency);
        return (
          <Container
            key={badge.memberId}
            position="absolute"
            style={{ left: badge.rect.x + badge.rect.w - 16, top: badge.rect.y - 12, zIndex: 56 }}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpen(badge.memberId)}
              aria-label={`Due ${badge.label} on ${badge.memberId}`}
            >
              <Container layout="horizontal" gap="xs" alignItems="center" style={{ border: `1px solid ${color}`, borderRadius: 999, padding: '0 4px' }}>
                <Text variant="caption" style={{ color }}>{`⏱ ${badge.label}`}</Text>
              </Container>
            </Button>
          </Container>
        );
      })}
    </>
  );
}
