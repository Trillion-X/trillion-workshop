// packages/group/show/BoardTimeLayer.tsx
//
// The at-a-glance surface for the time-log primitive: a total-time pill (⏱ 2h 30m) on every item that
// has logged effort, click to open its TimeLogPanel. Generic + DATA-driven — it renders whatever pills
// it is handed and never names an item; the mount resolves each item to a screen rect + totals its log.
// L065: ui only; the pill is a positioned Container because its coordinate is dynamic (like the metric
// / checklist / due badges).

import { Button, Container, Text } from '../../ui';

export interface TimePillRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pill: an item's screen rect + a short total-time label. */
export interface TimePill {
  readonly memberId: string;
  readonly rect: TimePillRect;
  readonly label: string;
}

export interface BoardTimeLayerProps {
  readonly pills: readonly TimePill[];
  readonly onOpen: (memberId: string) => void;
}

export function BoardTimeLayer({ pills, onOpen }: BoardTimeLayerProps): JSX.Element {
  return (
    <>
      {pills.map((pill) => (
        <Container
          key={pill.memberId}
          position="absolute"
          style={{ left: pill.rect.x - 6, top: pill.rect.y + pill.rect.h - 8, zIndex: 56 }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpen(pill.memberId)}
            aria-label={`Time logged ${pill.label} on ${pill.memberId}`}
          >
            <Text variant="caption">{`⏱ ${pill.label}`}</Text>
          </Button>
        </Container>
      ))}
    </>
  );
}
