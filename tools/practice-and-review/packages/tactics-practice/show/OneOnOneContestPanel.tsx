import * as React from 'react';
import { Bar } from '@/packages/ui/show/bar/Bar';
import { Badge } from '@/packages/ui/show/badge';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import type {
  TacticsContestView,
} from '@/packages/tactics-practice/read-data/tactics-practice-types';
import { displayName, type NameResolver } from '@/packages/tactics-practice/show/humanize-ref';
import { PeerVoteSplit } from '@/packages/tactics-practice/show/PeerVoteSplit';

// One-on-one tactics contest panel.
//
// Reference anatomy (Mobbin, 2026-06-20):
//   Head-to-head      Hevy 0f91d578 ("A VS B", STRONGER badge, per-metric bars),
//                     X 9ec6e1a1 (side-by-side stat rows, centered labels)
//   Live vote split   Twitch a47d5347 / 337c56f4 (live %/(n), voted state)
//   Comparison density Circle cd5daccd (ranked rows + filters)
// Banned transfers (rejected): streaming-overlay chat chrome and any
// rematch-for-coins / paid-challenge affordance.

export type OneOnOneContestPanelProps = {
  view: TacticsContestView;
  viewerId?: string;
  nameFor?: NameResolver;
};

export function OneOnOneContestPanel({ view, viewerId, nameFor }: OneOnOneContestPanelProps) {
  const { contest, scenarios, votes, ratingEffects } = view;
  const scenario = scenarios[0];

  const pointsByPlayer = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const effect of ratingEffects) {
      totals.set(effect.playerId, (totals.get(effect.playerId) ?? 0) + effect.delta);
    }
    return totals;
  }, [ratingEffects]);

  const participants = (contest?.participantRefs ?? []).slice(0, 2);
  const [left, right] = participants;
  const leftPoints = left ? pointsByPlayer.get(left) ?? 0 : 0;
  const rightPoints = right ? pointsByPlayer.get(right) ?? 0 : 0;
  const span = Math.max(Math.abs(leftPoints), Math.abs(rightPoints), 1);
  const leftPct = Math.round((Math.max(leftPoints, 0) / span) * 100);
  const rightPct = Math.round((Math.max(rightPoints, 0) / span) * 100);

  return (
    <Card variant="nested" padding="md" layout="stack">
      <Text variant="heading-lg">One-on-one tactics</Text>
      {scenario ? (
        <Container layout="vertical" gap="xs">
          <Text variant="body-xs" color="strong">
            {scenario.title}
          </Text>
          <Text variant="caption" color="muted">
            {scenario.situation}
          </Text>
        </Container>
      ) : null}

      {left && right ? (
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="body-xs" color={left === viewerId ? 'strong' : 'default'}>
              {displayName(left, nameFor)}
              {left === viewerId ? ' · you' : ''}
            </Text>
            <Badge variant="neutral" size="sm">
              VS
            </Badge>
            <Text variant="body-xs" color={right === viewerId ? 'strong' : 'default'}>
              {displayName(right, nameFor)}
              {right === viewerId ? ' · you' : ''}
            </Text>
          </Container>
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Text variant="caption" color="muted">
              {leftPoints}
            </Text>
            <Container layout="vertical" gap="xs" flex="1">
              <Bar height="sm" segments={[{ percent: leftPct, variant: 'info', title: `${displayName(left, nameFor)}: ${leftPoints}` }]} />
              <Bar height="sm" segments={[{ percent: rightPct, variant: 'accent', title: `${displayName(right, nameFor)}: ${rightPoints}` }]} />
            </Container>
            <Text variant="caption" color="muted">
              {rightPoints}
            </Text>
          </Container>
          {leftPoints !== rightPoints ? (
            <Text variant="caption" color="success">
              {displayName(leftPoints > rightPoints ? left : right, nameFor)} is ahead
            </Text>
          ) : (
            <Text variant="caption" color="muted">
              Dead even
            </Text>
          )}
        </Container>
      ) : (
        <Text variant="body-xs" color="muted">
          Waiting for a challenger.
        </Text>
      )}

      <PeerVoteSplit votes={votes} viewerId={viewerId} />
    </Card>
  );
}
