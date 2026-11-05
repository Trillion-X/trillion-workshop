// packages/group/show/BoardVotesLayer.tsx
//
// The product surface for the vote-tally primitive (read-data/board-votes): a vote chip on each item.
// In VOTING mode every vote target shows a chip with the total count + this actor's +/- (the minus
// shows only when the actor has a dot here; the plus disables when the actor is out of budget). Outside
// voting mode, only items WITH votes show a read-only count pill (so the tally stays visible without
// clutter). Generic + DATA-driven — it renders whatever chips it is handed and never names an item; the
// mount resolves each target to a screen rect and owns voting-mode + actor + budget. L065: ui only; the
// chip is a positioned Container because its coordinate is dynamic (like the comments pin).

import { Button, Container, Icon, Text } from '../../ui/index.ts';
import { ThumbsUp } from 'lucide-react';

export interface VoteChipRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One chip to draw: an item's screen rect + its total votes + this actor's own dots. */
export interface VoteChip {
  readonly memberId: string;
  readonly rect: VoteChipRect;
  readonly count: number;
  readonly mine: number;
}

export interface BoardVotesLayerProps {
  readonly chips: readonly VoteChip[];
  /** True while a voting round is active — show +/- controls; else read-only count pills. */
  readonly voting: boolean;
  /** This actor's remaining dots — the plus disables at 0. */
  readonly budgetRemaining: number;
  readonly onVote: (memberId: string, delta: number) => void;
}

export function BoardVotesLayer({ chips, voting, budgetRemaining, onVote }: BoardVotesLayerProps): JSX.Element {
  return (
    <>
      {chips.map((chip) => {
        // Outside voting mode, an unvoted item shows nothing (no clutter).
        if (!voting && chip.count === 0) return null;
        return (
          <Container
            key={chip.memberId}
            position="absolute"
            style={{ left: chip.rect.x - 6, top: chip.rect.y - 12, zIndex: 56 }}
          >
            <Container layout="horizontal" gap="xs" alignItems="center" style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 999, padding: '1px 4px', boxShadow: '0 1px 3px rgba(15,23,42,.15)' }}>
              {voting ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onVote(chip.memberId, -1)}
                  disabled={chip.mine <= 0}
                  aria-label="Take my vote back"
                >
                  −
                </Button>
              ) : null}
              {/* The tally reads as VOTES (thumb + count), not an unexplained blue dot (R24);
                  title + aria-label spell it out for hover and screen readers. */}
              <Container
                layout="horizontal"
                gap="xs"
                alignItems="center"
                aria-label={voting ? `${chip.count} votes — press + to add yours` : `${chip.count} votes`}
                title={voting ? `${chip.count} votes — press + to add yours` : `${chip.count} votes`}
              >
                <Icon icon={ThumbsUp} size="xs" />
                <Text variant="body-sm" weight="semibold">{`${chip.count}`}</Text>
              </Container>
              {voting ? (
                <Button
                  variant={chip.mine > 0 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => onVote(chip.memberId, 1)}
                  disabled={budgetRemaining <= 0}
                  aria-label="Add my vote"
                >
                  +
                </Button>
              ) : null}
            </Container>
          </Container>
        );
      })}
    </>
  );
}
