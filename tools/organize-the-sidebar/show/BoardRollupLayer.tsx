// packages/group/show/BoardRollupLayer.tsx
//
// The at-a-glance surface for the goal-rollup primitive: a rolled-up-progress badge on every card that
// HAS children under the board's hierarchy relation (a vision showing its sub-goals' aggregate). It is
// HONEST about coverage (per the Codex convergence): it shows a percent + "N/M tracked" only when at
// least one child is measured, and NEVER a fake 0% when nothing under it is measured (it shows "0/M"
// instead). Click opens the breakdown panel. L065: ui only; the badge is a positioned Container because
// its coordinate is dynamic (like the metric / time / due badges).

import { Button, Container, Text } from '../../ui/index.ts';

export interface RollupPillRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pill: a parent card's screen rect + its rolled-up percent (undefined when no child is measured). */
export interface RollupPill {
  readonly memberId: string;
  readonly rect: RollupPillRect;
  readonly pct?: number;
  readonly contributing: number;
  readonly childCount: number;
}

export interface BoardRollupLayerProps {
  readonly pills: readonly RollupPill[];
  readonly onOpen: (memberId: string) => void;
}

export function BoardRollupLayer({ pills, onOpen }: BoardRollupLayerProps): JSX.Element {
  return (
    <>
      {pills.map((pill) => {
        const measured = pill.pct !== undefined;
        const text = measured
          ? `⤴ ${pill.pct}% · ${pill.contributing}/${pill.childCount}`
          : `⤴ 0/${pill.childCount}`; // no fake percent when nothing under it is measured
        return (
          <Container
            key={pill.memberId}
            position="absolute"
            style={{ left: pill.rect.x - 6, top: pill.rect.y - 14, zIndex: 56 }}
          >
            <Button
              variant={measured ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onOpen(pill.memberId)}
              aria-label={measured ? `Rolls up to ${pill.pct}% from ${pill.contributing} of ${pill.childCount} sub-goals` : `${pill.childCount} sub-goals, none measured yet`}
            >
              <Text variant="caption">{text}</Text>
            </Button>
          </Container>
        );
      })}
    </>
  );
}
