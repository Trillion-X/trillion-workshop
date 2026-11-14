import * as React from 'react';
import { Badge } from '@/packages/ui/show/badge';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Divider } from '@/packages/ui/show/divider/Divider';
import { Text } from '@/packages/ui/show/text';
import type {
  TacticsSeasonTournamentView,
} from '@/packages/tactics-practice/read-data/tactics-practice-types';
import { displayName, type NameResolver } from '@/packages/tactics-practice/show/humanize-ref';

// Season tactics tournament panel.
//
// Reference anatomy (Mobbin, 2026-06-20):
//   Champion banner   Kahoot! 904858e1 (podium + self rank), Stadium Live d4a95004 (FINAL RANK)
//   Invite accept     ChatGPT 8db8b89c (join / ignore), Microsoft Teams 747d2570 (invites sent)
//   Division tier     Mimo 81103f71 (tier badge + weekly reset), Premier League d9e1225e (table)
//   Bracket           DAZN 90742421 / NBA 8772414e / Apple News 94eb32bf (rounds + matchup + score)
//   Profile           Duolingo 70dbded5 (stat tiles + achievements)
// Banned transfers (rejected): team-logo/league ad chrome, loot/prize-pool
// reward economy, and any "buy entry" payment affordance on the tournament view.

export type SeasonTournamentPanelProps = {
  view: TacticsSeasonTournamentView;
  viewerId?: string;
  nameFor?: NameResolver;
};

const ROUND_ORDER = ['group', 'round-of-16', 'quarterfinal', 'semifinal', 'final'];

function roundRank(round: string): number {
  const index = ROUND_ORDER.indexOf(round.toLowerCase());
  return index === -1 ? ROUND_ORDER.length : index;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function SeasonTournamentPanel({ view, viewerId, nameFor }: SeasonTournamentPanelProps) {
  const { season, invites, divisions, brackets, weeklyScenarios, championResult, coachReviews, profiles } = view;

  const acceptedInvites = invites.filter((invite) => invite.state === 'accepted').length;
  const pendingInvites = invites.filter((invite) => invite.state === 'invited');

  const rounds = React.useMemo(() => {
    const grouped = new Map<string, typeof brackets>();
    for (const match of brackets) {
      const list = grouped.get(match.round) ?? [];
      list.push(match);
      grouped.set(match.round, list);
    }
    return [...grouped.entries()].sort((a, b) => roundRank(a[0]) - roundRank(b[0]));
  }, [brackets]);

  const nextWeek = weeklyScenarios[0];

  return (
    <Card variant="nested" padding="md" layout="stack">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Text variant="heading-lg">{season.label}</Text>
        <Badge variant={season.inviteOnly ? 'accent' : 'muted'} size="sm">
          {season.inviteOnly ? 'Invite only' : 'Open season'}
        </Badge>
      </Container>
      <Text variant="caption" color="muted">
        {season.weekCount} weeks · {acceptedInvites} players in
      </Text>

      {championResult ? (
        <Card variant="accent" padding="sm" layout="stack">
          <Text variant="overline" color="accent">
            Season champion
          </Text>
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="heading-lg">{displayName(championResult.playerRef, nameFor)}</Text>
            <Text variant="body-xs" color="muted">
              {championResult.score} pts
            </Text>
          </Container>
        </Card>
      ) : null}

      {nextWeek ? (
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xs">This week&apos;s scenario</Text>
          <Text variant="body-xs" color="strong">
            {nextWeek.title}
          </Text>
          <Text variant="caption" color="muted">
            {nextWeek.situation}
          </Text>
        </Container>
      ) : null}

      {divisions.length > 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xs">Divisions</Text>
          {divisions.map((division) => (
            <Container key={division.divisionId} layout="horizontal" justifyContent="between" alignItems="center" padding="xs">
              <Text variant="body-xs">{division.label}</Text>
              <Text variant="caption" color="muted">
                {division.playerRefs.length} players
              </Text>
            </Container>
          ))}
        </Container>
      ) : null}

      {rounds.length > 0 ? (
        <Container layout="vertical" gap="sm">
          <Text variant="heading-xs">Bracket</Text>
          {rounds.map(([round, matches]) => (
            <Container key={round} layout="vertical" gap="xs">
              <Text variant="overline" color="muted">
                {titleCase(round)}
              </Text>
              {matches.map((match) => (
                <Container key={match.matchId} layout="vertical" gap="xs" padding="xs">
                  {match.playerRefs.map((playerRef) => {
                    const isWinner = match.winnerRef === playerRef;
                    const isViewer = Boolean(viewerId) && playerRef === viewerId;
                    return (
                      <Container key={playerRef} layout="horizontal" justifyContent="between" alignItems="center">
                        <Text variant="body-xs" color={isWinner ? 'strong' : isViewer ? 'strong' : 'default'}>
                          {displayName(playerRef, nameFor)}
                          {isViewer ? ' · you' : ''}
                        </Text>
                        {isWinner ? (
                          <Badge variant="success" size="sm">
                            Advances
                          </Badge>
                        ) : null}
                      </Container>
                    );
                  })}
                  <Divider orientation="horizontal" />
                </Container>
              ))}
            </Container>
          ))}
        </Container>
      ) : null}

      {coachReviews.length > 0 ? (
        <Container layout="vertical" gap="sm">
          <Text variant="heading-xs">Coach review</Text>
          {coachReviews.map((review) => (
            <Card key={review.coachReviewId} variant="ghost" padding="sm" layout="stack">
              <Text variant="body-xs" color="strong">
                {review.title}
              </Text>
              {review.points.map((point, index) => (
                <Text key={index} variant="caption" color="muted">
                  • {point}
                </Text>
              ))}
              {review.nextPromptRefs.length > 0 ? (
                <Text variant="caption" color="accent">
                  {review.nextPromptRefs.length} next {review.nextPromptRefs.length === 1 ? 'tactic' : 'tactics'} to drill
                </Text>
              ) : null}
            </Card>
          ))}
        </Container>
      ) : null}

      {pendingInvites.length > 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xs">Invites out</Text>
          {pendingInvites.map((invite) => (
            <Container key={invite.inviteId} layout="horizontal" justifyContent="between" alignItems="center" padding="xs">
              <Text variant="body-xs">{displayName(invite.playerRef, nameFor)}</Text>
              <Badge variant="muted" size="sm">
                Pending
              </Badge>
            </Container>
          ))}
        </Container>
      ) : null}

      {profiles.length > 0 ? (
        <Text variant="caption" color="muted">
          {profiles.length} player {profiles.length === 1 ? 'profile' : 'profiles'} linked to this season
        </Text>
      ) : null}
    </Card>
  );
}
