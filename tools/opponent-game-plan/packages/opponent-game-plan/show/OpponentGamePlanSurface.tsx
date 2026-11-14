import * as React from 'react';
import { ClipboardList, Search } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input, Textarea } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  addPlayerReport,
  buildAddPlayerReportInput,
} from '@/packages/opponent-game-plan/do-work/add-player-report';
import {
  buildRecordTacticResultInput,
  recordTacticResult,
} from '@/packages/opponent-game-plan/do-work/record-tactic-result';
import {
  buildRequestMatchPlanInput,
  requestMatchPlan,
} from '@/packages/opponent-game-plan/do-work/request-match-plan';
import {
  profileForPlayer,
  latestPlanForMatch,
  opponentSearchRows,
  readOpponentGamePlanState,
} from '@/packages/opponent-game-plan/read-data/read-opponent-game-plan';
import type { MatchPlanTactic, TacticResultOutcome } from '@/packages/opponent-game-plan/read-data/opponent-game-plan-types';

type OpponentGamePlanSurfaceProps = {
  userId?: string;
  selfPlayerId?: string;
};

function splitLines(text: string): string[] {
  return text.split(/\n|,/).map((line) => line.trim()).filter(Boolean);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || crypto.randomUUID();
}

export function OpponentGamePlanSurface({ selfPlayerId, userId }: OpponentGamePlanSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readOpponentGamePlanState(rows), [rows]);
  const searchRows = React.useMemo(() => opponentSearchRows(state), [state]);
  const [query, setQuery] = React.useState('');
  const filteredRows = React.useMemo(() => {
    const lower = query.trim().toLowerCase();
    return lower ? searchRows.filter((row) => row.name.toLowerCase().includes(lower)) : searchRows;
  }, [query, searchRows]);
  const [selectedPlayerId, setSelectedPlayerId] = React.useState<string | undefined>(filteredRows[0]?.playerId);
  const [newPlayerName, setNewPlayerName] = React.useState('');
  const [newStrengths, setNewStrengths] = React.useState('');
  const [newWeaknesses, setNewWeaknesses] = React.useState('');
  const [newWorked, setNewWorked] = React.useState('');
  const [newFailed, setNewFailed] = React.useState('');
  const [scoutingText, setScoutingText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = selectedPlayerId ? profileForPlayer(state, selectedPlayerId) : undefined;
  const self = selfPlayerId ? profileForPlayer(state, selfPlayerId) : undefined;
  const latestPlan = selfPlayerId && selectedPlayerId ? latestPlanForMatch(state, selfPlayerId, selectedPlayerId) : undefined;

  React.useEffect(() => {
    if (!selectedPlayerId && filteredRows[0]) setSelectedPlayerId(filteredRows[0].playerId);
  }, [filteredRows, selectedPlayerId]);

  const saveScouting = React.useCallback(async () => {
    if (!selected?.player || !userId) {
      setMessage('Choose your profile and a player first.');
      return;
    }
    const lines = splitLines(scoutingText);
    if (lines.length === 0) {
      setMessage('Write a scouting note first.');
      return;
    }
    await addPlayerReport(buildAddPlayerReportInput({
      authorId: userId,
      notes: scoutingText,
      playerId: selected.player.subjectId,
      playerName: selected.player.label,
      strategiesFailed: [],
      strategiesWorked: lines,
      visibility: 'private',
    }));
    setScoutingText('');
    setMessage('Scouting saved.');
  }, [scoutingText, selected?.player, userId]);

  const saveFirstReport = React.useCallback(async () => {
    if (!userId) {
      setMessage('Choose your profile before saving scouting.');
      return;
    }
    const playerName = newPlayerName.trim();
    if (!playerName) {
      setMessage('Add the player name first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const playerId = `tennis-player:${slug(playerName)}`;
      await addPlayerReport(buildAddPlayerReportInput({
        authorId: userId,
        notes: scoutingText,
        playerId,
        playerName,
        strengths: splitLines(newStrengths),
        weaknesses: splitLines(newWeaknesses),
        strategiesWorked: splitLines(newWorked),
        strategiesFailed: splitLines(newFailed),
        visibility: 'private',
      }));
      setSelectedPlayerId(playerId);
      setNewPlayerName('');
      setNewStrengths('');
      setNewWeaknesses('');
      setNewWorked('');
      setNewFailed('');
      setScoutingText('');
      setMessage('Scouting saved.');
    } catch {
      setMessage('Scouting could not save.');
    } finally {
      setBusy(false);
    }
  }, [newFailed, newPlayerName, newStrengths, newWeaknesses, newWorked, scoutingText, userId]);

  const askForPlan = React.useCallback(async () => {
    if (!self || !selected || !selfPlayerId || !selectedPlayerId || !userId) {
      setMessage('Choose your profile and a player first.');
      return;
    }
    await requestMatchPlan(buildRequestMatchPlanInput({
      opponentProfile: selected,
      opponentPlayerId: selectedPlayerId,
      requesterId: userId,
      selfProfile: self,
      selfPlayerId,
    }));
    setMessage('Match plan requested.');
  }, [selected, selectedPlayerId, self, selfPlayerId, userId]);

  const markTactic = React.useCallback(async (tactic: MatchPlanTactic, outcome: TacticResultOutcome, strategyId: string) => {
    if (!latestPlan || !selectedPlayerId || !selfPlayerId) return;
    await recordTacticResult(buildRecordTacticResultInput({
      opponentPlayerId: selectedPlayerId,
      outcome,
      planId: latestPlan.planId,
      selfPlayerId,
      strategyId,
      tacticId: tactic.tacticId,
    }));
    setMessage(outcome === 'worked' ? 'Tactic marked worked.' : 'Tactic marked did not work.');
  }, [latestPlan, selectedPlayerId, selfPlayerId]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Opponent Game Plan</Text>
      <Input
        placeholder="Search player"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {message ? (
        <Text variant="body-xs" color={message.endsWith('saved.') || message.endsWith('requested.') || message.endsWith('work.') ? 'success' : 'warning'}>
          {message}
        </Text>
      ) : null}
      <Container layout="vertical" gap="xs">
        {filteredRows.map((row) => (
          <Button
            key={row.playerId}
            type="button"
            variant="secondary"
            active={row.playerId === selectedPlayerId}
            onClick={() => setSelectedPlayerId(row.playerId)}
          >
            {row.name}
          </Button>
        ))}
        {filteredRows.length === 0 ? (
          <WorkStartState
            icon={Search}
            title={query.trim() ? 'No matching player yet' : 'Create the first opponent report'}
            description="Add the opponent, the patterns that hurt you, and the counters you want to remember before the match."
            items={[
              { label: 'Player dossier', detail: 'Name, strengths, weaknesses, and shot notes.', badge: 'profile', tone: 'info' },
              { label: 'Worked / failed', detail: 'Keep the practical tactics that survived real points.', badge: 'field notes', tone: 'success' },
              { label: 'Match plan', detail: 'Reports become the input for the plan request.', badge: 'next' },
            ]}
            action={(
              <Button type="button" variant="primary" onClick={() => void saveFirstReport()} disabled={!newPlayerName.trim() || busy} loading={busy}>
                Save scouting
              </Button>
            )}
          >
            <Container layout="grid" gridCols={2} gap="sm">
              <Input placeholder="Opponent name" value={newPlayerName} onChange={(event) => setNewPlayerName(event.currentTarget.value)} />
              <Input placeholder="Strengths" value={newStrengths} onChange={(event) => setNewStrengths(event.currentTarget.value)} />
              <Input placeholder="Weaknesses" value={newWeaknesses} onChange={(event) => setNewWeaknesses(event.currentTarget.value)} />
              <Input placeholder="What worked" value={newWorked} onChange={(event) => setNewWorked(event.currentTarget.value)} />
              <Input placeholder="What failed" value={newFailed} onChange={(event) => setNewFailed(event.currentTarget.value)} />
            </Container>
            <Textarea
              placeholder="Scouting notes"
              rows={4}
              value={scoutingText}
              onChange={(event) => setScoutingText(event.currentTarget.value)}
            />
            <WorkSkeletonRows rows={2} />
          </WorkStartState>
        ) : null}
      </Container>
      {selected?.player ? (
        <Container layout="vertical" gap="md">
          <Card variant="nested" padding="md">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="heading-lg" leading="tight">{selected.player.label}</Text>
                <Text variant="body-xs" color="faint">{selected.styleLabels.join(', ') || 'Style still being learned'}</Text>
              </Container>
              <Badge variant="info" size="sm">Scouting</Badge>
            </Container>
          </Card>
          <Container layout="grid" gridCols={2} gap="sm">
            <Card variant="nested" padding="md">
              <Text variant="heading">Strengths</Text>
              <Text variant="body" color="muted">{selected.strengths.join(', ') || 'Unknown'}</Text>
            </Card>
            <Card variant="nested" padding="md">
              <Text variant="heading">Weaknesses</Text>
              <Text variant="body" color="muted">{selected.weaknesses.join(', ') || 'Unknown'}</Text>
            </Card>
          </Container>
          <Card variant="nested" padding="md">
            <Text variant="heading">Shot Ratings</Text>
            {Object.entries(selected.shotRatings).length > 0 ? (
              Object.entries(selected.shotRatings).map(([shot, value]) => (
                <Text key={shot} variant="body" color="muted">{shot}: {value}/100</Text>
              ))
            ) : (
              <Text variant="body" color="muted">Unknown</Text>
            )}
          </Card>
          <Textarea
            placeholder="Add what worked against this player"
            rows={4}
            value={scoutingText}
            onChange={(event) => setScoutingText(event.currentTarget.value)}
          />
          <Container layout="horizontal" gap="sm" justifyContent="end" alignItems="center" wrap>
            {message ? <Text variant="body-xs" color="success">{message}</Text> : null}
            <Button type="button" variant="secondary" onClick={saveScouting}>
              Save scouting
            </Button>
            <Button type="button" variant="primary" onClick={askForPlan}>
              Get match plan
            </Button>
          </Container>
          {latestPlan ? (
            <Container layout="vertical" gap="md">
              {latestPlan.strategies.map((strategy) => (
                <Card key={strategy.strategyId} variant="nested" padding="md">
                  <Text variant="heading">{strategy.name}</Text>
                  {strategy.tactics.map((tactic) => (
                    <Container key={tactic.tacticId} layout="vertical" gap="xs">
                      <Text variant="body">{tactic.label}</Text>
                      <Container layout="horizontal" gap="xs" wrap>
                        <Button type="button" size="sm" variant="success" onClick={() => void markTactic(tactic, 'worked', strategy.strategyId)}>
                          Worked
                        </Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => void markTactic(tactic, 'failed', strategy.strategyId)}>
                          Did not work
                        </Button>
                      </Container>
                    </Container>
                  ))}
                </Card>
              ))}
            </Container>
          ) : (
            <WorkStartState
              icon={ClipboardList}
              title="Match plan waits for both player profiles"
              description="Once your profile and this opponent profile are selected, the plan request can produce the tactic checklist."
            />
          )}
        </Container>
      ) : null}
    </Container>
  );
}
