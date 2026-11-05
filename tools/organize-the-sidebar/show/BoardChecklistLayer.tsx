// packages/group/show/BoardChecklistLayer.tsx
//
// The at-a-glance surface for the checklist primitive: a progress pill on every item that HAS a
// checklist (done/total, tinted green when complete), click to open its ChecklistPanel. Generic +
// DATA-driven — it renders whatever pills it is handed and never names an item; the mount resolves each
// item to a screen rect and owns which panel is open. L065: ui only; the pill is a positioned Container
// because its coordinate is dynamic (like the comments pin / vote chip).

import { Button, Container, Text } from '../../ui/index.ts';

export interface ChecklistPillRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pill: an item's screen rect + its checklist progress (done/total). */
export interface ChecklistPill {
  readonly memberId: string;
  readonly rect: ChecklistPillRect;
  readonly done: number;
  readonly total: number;
}

export interface BoardChecklistLayerProps {
  readonly pills: readonly ChecklistPill[];
  readonly onOpen: (memberId: string) => void;
}

export function BoardChecklistLayer({ pills, onOpen }: BoardChecklistLayerProps): JSX.Element {
  return (
    <>
      {pills.map((pill) => {
        if (pill.total === 0) return null;
        const complete = pill.done === pill.total;
        return (
          <Container
            key={pill.memberId}
            position="absolute"
            style={{ left: pill.rect.x - 6, top: pill.rect.y + pill.rect.h - 8, zIndex: 56 }}
          >
            <Button
              variant={complete ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onOpen(pill.memberId)}
              aria-label={`Checklist ${pill.done} of ${pill.total} on ${pill.memberId}`}
            >
              <Text variant="caption">{`☑ ${pill.done}/${pill.total}`}</Text>
            </Button>
          </Container>
        );
      })}
    </>
  );
}
