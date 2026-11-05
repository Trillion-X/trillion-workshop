// packages/group/show/BoardMetricLayer.tsx
//
// The at-a-glance surface for the metric primitive: a compact progress pill on every item that HAS a
// metric (a filled bar + "N%", green when the target is met), click to open its MetricPanel. Generic +
// DATA-driven — it renders whatever pills it is handed and never names an item; the mount resolves each
// item to a screen rect and owns which panel is open. L065: ui only; the pill is a positioned Container
// because its coordinate is dynamic (like the checklist pill / due badge).

import { Button, Container, ProgressBar, Text } from '../../ui/index.ts';

export interface MetricPillRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pill: an item's screen rect + its completion percent (0..100) + a short value label + done flag. */
export interface MetricPill {
  readonly memberId: string;
  readonly rect: MetricPillRect;
  readonly pct: number;
  readonly value: string;
  readonly complete: boolean;
}

export interface BoardMetricLayerProps {
  readonly pills: readonly MetricPill[];
  readonly onOpen: (memberId: string) => void;
}

export function BoardMetricLayer({ pills, onOpen }: BoardMetricLayerProps): JSX.Element {
  return (
    <>
      {pills.map((pill) => (
        <Container
          key={pill.memberId}
          position="absolute"
          style={{ left: pill.rect.x - 6, top: pill.rect.y + pill.rect.h - 8, zIndex: 56 }}
        >
          <Button
            variant={pill.complete ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => onOpen(pill.memberId)}
            aria-label={`Progress ${pill.pct}% (${pill.value}) on ${pill.memberId}`}
          >
            <Container layout="horizontal" gap="xs" alignItems="center" style={{ minWidth: 88 }}>
              <Container style={{ flex: 1, minWidth: 44 }}>
                <ProgressBar
                  percentage={pill.pct}
                  color={pill.complete ? 'var(--color-success, #16a34a)' : 'var(--accent-primary, #3b6fe0)'}
                />
              </Container>
              <Text variant="caption">{`${pill.pct}%`}</Text>
            </Container>
          </Button>
        </Container>
      ))}
    </>
  );
}
