import * as React from 'react';
import { Container } from '@/packages/ui/show/container';
import { Divider } from '@/packages/ui/show/divider/Divider';
import { Text } from '@/packages/ui/show/text';
import type {
  TacticalRatingEffect,
} from '@/packages/tactics-practice/read-data/tactics-practice-types';
import { displayName, type NameResolver } from '@/packages/tactics-practice/show/humanize-ref';

// Tactical rating standings.
//
// Reference anatomy (Mobbin, 2026-06-20): ranked rows (rank · player · points)
// with the viewer's own row highlighted and a promotion/relegation divider.
//   Stadium Live  14c18d79  (podium + ranked rows + points)
//   Uxcel Go      8baf7fae  (promotion-zone divider, self-row highlight)
//   Premier League d9e1225e (position + up/down movement + total points)
// Banned transfers (rejected): prize/coin/treasure reward banners and cartoon
// avatar economy — the rating is a tactical standing, not a game wallet.

export type TacticalRatingStandingsProps = {
  effects: TacticalRatingEffect[];
  viewerId?: string;
  /** Index after which rows sit below the promotion line (1-based count kept up). */
  promotionCount?: number;
  nameFor?: NameResolver;
};

type StandingRow = {
  playerId: string;
  points: number;
  lastDelta: number;
};

export function TacticalRatingStandings({
  effects,
  viewerId,
  promotionCount,
  nameFor,
}: TacticalRatingStandingsProps) {
  const rows = React.useMemo<StandingRow[]>(() => {
    const totals = new Map<string, StandingRow>();
    for (const effect of effects) {
      const row = totals.get(effect.playerId) ?? { playerId: effect.playerId, points: 0, lastDelta: 0 };
      row.points += effect.delta;
      row.lastDelta = effect.delta;
      totals.set(effect.playerId, row);
    }
    return [...totals.values()].sort((a, b) => b.points - a.points);
  }, [effects]);

  if (rows.length === 0) {
    return (
      <Text variant="body-xs" color="muted">
        No tactical ratings yet. Answer tactics to climb the standings.
      </Text>
    );
  }

  return (
    <Container layout="vertical" gap="xs">
      <Text variant="heading-xs">Tactical rating standings</Text>
      {rows.map((row, index) => {
        const rank = index + 1;
        const isViewer = Boolean(viewerId) && row.playerId === viewerId;
        const showDivider = promotionCount !== undefined && rank === promotionCount && index < rows.length - 1;
        const movement = row.lastDelta > 0 ? '▲' : row.lastDelta < 0 ? '▼' : '–';
        const movementColor = row.lastDelta > 0 ? 'success' : row.lastDelta < 0 ? 'warning' : 'muted';
        return (
          <React.Fragment key={row.playerId}>
            <Container
              layout="horizontal"
              gap="sm"
              alignItems="center"
              justifyContent="between"
              padding="xs"
            >
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Text variant="body-xs" color="muted">
                  {rank}
                </Text>
                <Text variant="body-xs" color={movementColor}>
                  {movement}
                </Text>
                <Text variant="body-xs" color={isViewer ? 'strong' : 'default'}>
                  {displayName(row.playerId, nameFor)}
                  {isViewer ? ' · you' : ''}
                </Text>
              </Container>
              <Text variant="body-xs" color="strong">
                {row.points}
              </Text>
            </Container>
            {showDivider ? (
              <Container layout="vertical" gap="xs">
                <Text variant="overline" color="success">
                  Promotion line
                </Text>
                <Divider orientation="horizontal" />
              </Container>
            ) : null}
          </React.Fragment>
        );
      })}
    </Container>
  );
}
