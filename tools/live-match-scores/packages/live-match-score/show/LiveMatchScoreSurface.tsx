import * as React from 'react';
import { RadioTower, Trophy } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildAdvanceScoreEventInput,
  buildRecordScoreEventInput,
  recordScoreEvent,
} from '@/packages/live-match-score/do-work/record-score-event';
import {
  buildStartLiveMatchInput,
  startLiveMatch,
} from '@/packages/live-match-score/do-work/start-live-match';
import {
  liveMatchBoardRows,
  liveMatchScoreView,
  liveMatchScoreViews,
  nextSequenceForMatch,
  previousScoreForMatch,
  readLiveMatchScoreState,
} from '@/packages/live-match-score/read-data/read-live-match-score';
import type {
  LiveMatchFormat,
  LiveMatchRecord,
  LiveMatchScoreView,
  LiveScorePayload,
  LiveScoreSide,
} from '@/packages/live-match-score/read-data/live-match-score-types';
import {
  REFERENCE_SCORING_RULES,
  findScoringRule,
} from '@/packages/live-match-score/read-data/scoring-rules';

type LiveMatchScoreSurfaceProps = {
  userId?: string;
};

const emptyScore: LiveScorePayload = {
  setNumber: 1,
  teamScores: {
    'team-a': 0,
    'team-b': 0,
  },
};

function scoreText(score: LiveScorePayload, side: LiveScoreSide): string {
  return score.displayScores?.[side] ?? String(score.teamScores[side]);
}

function pairText(score: LiveScorePayload, key: 'setScores' | 'gameScores' | 'teamScores'): string {
  const pair = score[key] ?? score.teamScores;
  return `${pair['team-a'] ?? 0}-${pair['team-b'] ?? 0}`;
}

function phaseText(score: LiveScorePayload): string {
  if (score.winnerTeamId) return 'Match complete';
  if (score.scoringPhase === 'tiebreak') return 'Tiebreak';
  return `Set ${score.setNumber || 1}`;
}

function splitPlayers(primary: string, partner: string, matchFormat: LiveMatchFormat): string[] {
  return matchFormat === 'doubles' ? [primary, partner] : [primary];
}

function localViewFromMatch(match: LiveMatchRecord): LiveMatchScoreView {
  return {
    match,
    score: emptyScore,
    eventCount: 1,
    spectator: {
      matchId: match.matchId,
      scoringRuleRef: match.scoringRuleRef,
      matchFormat: match.matchFormat,
      teamLabels: [match.teams[0].label, match.teams[1].label],
      players: [match.teams[0].players, match.teams[1].players],
      score: emptyScore,
      status: match.status,
      publicPath: match.share.publicPath,
      eventCount: 1,
    },
  };
}

export function LiveMatchScoreSurface({ userId }: LiveMatchScoreSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readLiveMatchScoreState(rows), [rows]);
  const views = React.useMemo(() => liveMatchScoreViews(state), [state]);
  const boardRows = React.useMemo(() => liveMatchBoardRows(state), [state]);
  const [scoringRuleRef, setScoringRuleRef] = React.useState<string>(REFERENCE_SCORING_RULES[0].ruleId);
  const [matchFormat, setMatchFormat] = React.useState<LiveMatchFormat>('singles');
  const [teamAPlayer, setTeamAPlayer] = React.useState('');
  const [teamAPartner, setTeamAPartner] = React.useState('');
  const [teamBPlayer, setTeamBPlayer] = React.useState('');
  const [teamBPartner, setTeamBPartner] = React.useState('');
  const [activeMatchId, setActiveMatchId] = React.useState<string | undefined>(views[0]?.match.matchId);
  const [localMatch, setLocalMatch] = React.useState<LiveMatchRecord | undefined>();
  const [localScore, setLocalScore] = React.useState<LiveScorePayload | undefined>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const activeView = activeMatchId ? liveMatchScoreView(state, activeMatchId) : undefined;
  const view = activeView ?? (localMatch ? localViewFromMatch(localMatch) : undefined);
  const score = localScore ?? view?.score ?? emptyScore;
  const canStart = Boolean(teamAPlayer.trim() && teamBPlayer.trim() && !busy);

  React.useEffect(() => {
    if (!activeMatchId && views[0]) setActiveMatchId(views[0].match.matchId);
  }, [activeMatchId, views]);

  const start = React.useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const input = buildStartLiveMatchInput({
        createdBy: userId,
        matchFormat,
        scoringRuleRef,
        teamAPlayers: splitPlayers(teamAPlayer, teamAPartner, matchFormat),
        teamBPlayers: splitPlayers(teamBPlayer, teamBPartner, matchFormat),
      });
      await startLiveMatch(input);
      setActiveMatchId(input.match_id);
      setLocalMatch(input.match_record);
      setLocalScore(input.initial_event_record.score);
      setMessage('Match started.');
    } catch {
      setMessage('Match could not start.');
    } finally {
      setBusy(false);
    }
  }, [matchFormat, scoringRuleRef, teamAPlayer, teamAPartner, teamBPlayer, teamBPartner, userId]);

  const tapScore = React.useCallback(async (side: LiveScoreSide) => {
    if (!view) {
      setMessage('Start a match first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const baseEvent = {
        actorId: userId,
        matchId: view.match.matchId,
        sequence: activeView ? nextSequenceForMatch(state, view.match.matchId) : (view.latestEvent?.sequence ?? 0) + 1,
      };
      const input = buildAdvanceScoreEventInput({
        ...baseEvent,
        match: view.match,
        currentScore: score,
        side,
      });
      await recordScoreEvent(input);
      setLocalScore(input.event_record.score);
      setMessage('Score saved.');
    } catch {
      setMessage('Score could not save.');
    } finally {
      setBusy(false);
    }
  }, [activeView, score, state, userId, view]);

  const undoPoint = React.useCallback(async () => {
    if (!activeView) {
      setMessage('No saved point to undo.');
      return;
    }
    const previousScore = previousScoreForMatch(state, activeView.match.matchId);
    if (!previousScore) {
      setMessage('No saved point to undo.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const input = buildRecordScoreEventInput({
        actorId: userId,
        matchId: activeView.match.matchId,
        sequence: nextSequenceForMatch(state, activeView.match.matchId),
        score: previousScore,
      });
      await recordScoreEvent(input);
      setLocalScore(input.event_record.score);
      setMessage('Score saved.');
    } catch {
      setMessage('Score could not save.');
    } finally {
      setBusy(false);
    }
  }, [activeView, state, userId]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Live Match Score</Text>
      <Container layout="horizontal" gap="sm" wrap>
        {REFERENCE_SCORING_RULES.map((rule) => (
          <Button
            key={rule.ruleId}
            type="button"
            variant="secondary"
            active={scoringRuleRef === rule.ruleId}
            onClick={() => setScoringRuleRef(rule.ruleId)}
          >
            {rule.label}
          </Button>
        ))}
        <Button type="button" variant="secondary" active={matchFormat === 'singles'} onClick={() => setMatchFormat('singles')}>
          Singles
        </Button>
        <Button type="button" variant="secondary" active={matchFormat === 'doubles'} onClick={() => setMatchFormat('doubles')}>
          Doubles
        </Button>
      </Container>
      <Container layout="grid" gridCols={2} gap="sm">
        <Input placeholder="Player A" value={teamAPlayer} onChange={(event) => setTeamAPlayer(event.currentTarget.value)} />
        <Input placeholder="Player B" value={teamBPlayer} onChange={(event) => setTeamBPlayer(event.currentTarget.value)} />
        {matchFormat === 'doubles' ? (
          <>
            <Input placeholder="Partner A" value={teamAPartner} onChange={(event) => setTeamAPartner(event.currentTarget.value)} />
            <Input placeholder="Partner B" value={teamBPartner} onChange={(event) => setTeamBPartner(event.currentTarget.value)} />
          </>
        ) : null}
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
        {message ? (
          <Text variant="body-xs" color={message.endsWith('saved.') || message.endsWith('started.') ? 'success' : 'warning'}>
            {message}
          </Text>
        ) : null}
        <Button type="button" variant="primary" onClick={start} disabled={!canStart} loading={busy}>
          Start match
        </Button>
      </Container>
      {view ? (
        <Container layout="vertical" gap="md">
          <Card variant="nested" padding="md">
            <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="heading-lg" leading="tight">{phaseText(score)}</Text>
                <Text variant="body-xs" color="faint">{view.match.matchFormat} {findScoringRule(REFERENCE_SCORING_RULES, view.match.scoringRuleRef)?.label ?? view.match.scoringRuleRef}</Text>
              </Container>
              <Container layout="horizontal" gap="lg" alignItems="center" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" color="faint">Sets</Text>
                  <Text variant="body" weight="semibold" mono tabular>{pairText(score, 'setScores')}</Text>
                </Container>
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" color="faint">Games</Text>
                  <Text variant="body" weight="semibold" mono tabular>{pairText(score, 'gameScores')}</Text>
                </Container>
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" color="faint">Current point</Text>
                  <Text variant="body" weight="semibold" mono tabular>
                    {scoreText(score, 'team-a')}-{scoreText(score, 'team-b')}
                  </Text>
                </Container>
                <Badge variant={view.spectator.status === 'complete' ? 'success' : 'info'} size="lg">
                  {view.spectator.status === 'complete' ? 'Complete' : 'Live'}
                </Badge>
              </Container>
            </Container>
          </Card>
          <Container layout="grid" gridCols={2} gap="sm">
            {view.match.teams.map((team) => (
              <Card key={team.teamId} variant="nested" padding="md">
                <Container layout="vertical" gap="sm">
                <Text variant="heading">{team.label}</Text>
                <Text variant="heading-lg" leading="tight">{scoreText(score, team.teamId)}</Text>
                <Text variant="caption" color="faint">
                  Sets {score.setScores?.[team.teamId] ?? 0} / Games {(score.gameScores ?? score.teamScores)[team.teamId] ?? 0}
                </Text>
                <Container layout="horizontal" gap="xs" wrap>
                  <Button type="button" size="sm" variant="success" onClick={() => void tapScore(team.teamId)} disabled={busy || Boolean(score.winnerTeamId)}>
                    Point
                  </Button>
                </Container>
                </Container>
              </Card>
            ))}
          </Container>
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
            <Button type="button" size="sm" variant="secondary" onClick={() => void undoPoint()} disabled={busy || !activeView}>
              Undo last point
            </Button>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text variant="heading">Share Link</Text>
            <Text variant="body" color="muted">{view.match.share.publicPath}</Text>
          </Container>
        </Container>
      ) : (
        <WorkStartState
          icon={RadioTower}
          title="Start the live scoreboard"
          description="Enter the players, choose singles or doubles, then score each point. The match view will show sets, games, current point, and the spectator link."
          items={[
            { label: 'Tennis scoring', detail: 'Points advance through games, tiebreaks, sets, and match completion.', badge: 'ready', tone: 'success' },
            { label: 'Share link', detail: 'A spectator-safe match path is created when the match starts.', badge: 'live', tone: 'info' },
            { label: 'Live board', detail: 'Started matches appear in the board below with schedule and standings when linked.', badge: 'board' },
          ]}
        >
          <WorkSkeletonRows rows={3} />
        </WorkStartState>
      )}
      {boardRows.length > 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="heading">Live Board</Text>
          {boardRows.slice(0, 4).map((row) => (
            <Button key={row.matchId} type="button" variant="secondary" active={row.matchId === activeMatchId} onClick={() => setActiveMatchId(row.matchId)}>
              {row.label} {row.scoreLine}
            </Button>
          ))}
        </Container>
      ) : view ? null : (
        <WorkStartState
          icon={Trophy}
          title="Live board is waiting for the first match"
          description="Once a match starts, this area becomes the tournament-style list of live matches and score streams."
        />
      )}
    </Container>
  );
}
