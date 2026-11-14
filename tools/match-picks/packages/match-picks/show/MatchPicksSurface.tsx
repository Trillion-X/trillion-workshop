import * as React from 'react';
import { Trophy, Users } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildCreateMatchPickPromptInput,
  createMatchPickPrompt,
} from '@/packages/match-picks/do-work/create-pick-prompt';
import {
  buildSubmitMatchPickInput,
  submitMatchPick,
} from '@/packages/match-picks/do-work/submit-match-pick';
import {
  matchPickPersonalHistory,
  matchPickViews,
  readMatchPicksState,
} from '@/packages/match-picks/read-data/read-match-picks';

type MatchPicksSurfaceProps = {
  pickerId?: string;
};

export function MatchPicksSurface({ pickerId }: MatchPicksSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readMatchPicksState(rows), [rows]);
  const views = React.useMemo(() => matchPickViews(state, pickerId), [state, pickerId]);
  const history = React.useMemo(() => (pickerId ? matchPickPersonalHistory(state, pickerId) : []), [pickerId, state]);
  const [selectedMatchId, setSelectedMatchId] = React.useState<string | undefined>();
  const [promptLabel, setPromptLabel] = React.useState('');
  const [choiceA, setChoiceA] = React.useState('');
  const [choiceB, setChoiceB] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = views.find((view) => view.match.matchId === selectedMatchId) ?? views[0];
  const canCreatePrompt = Boolean(promptLabel.trim() && choiceA.trim() && choiceB.trim() && !busy);

  React.useEffect(() => {
    if (!selectedMatchId && views[0]) setSelectedMatchId(views[0].match.matchId);
  }, [selectedMatchId, views]);

  const pick = React.useCallback(async (choiceId: string) => {
    if (!pickerId || !selected) {
      setMessage('Choose a match first.');
      return;
    }
    await submitMatchPick(buildSubmitMatchPickInput({
      matchId: selected.match.matchId,
      pickerId,
      choiceId,
    }));
    setMessage('Pick saved.');
  }, [pickerId, selected]);

  const createPrompt = React.useCallback(async () => {
    if (!canCreatePrompt) {
      setMessage('Add a match and two choices first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const input = buildCreateMatchPickPromptInput({
        label: promptLabel,
        choices: [
          { choiceId: 'choice:a', label: choiceA },
          { choiceId: 'choice:b', label: choiceB },
        ],
      });
      await createMatchPickPrompt(input);
      setSelectedMatchId(input.match_id);
      setPromptLabel('');
      setChoiceA('');
      setChoiceB('');
      setMessage('Pick opened.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error("[match-picks] open failed:", raw); setMessage("Pick could not open.");
    } finally {
      setBusy(false);
    }
  }, [canCreatePrompt, choiceA, choiceB, promptLabel]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Match Picks</Text>
      {views.length === 0 ? (
        <WorkStartState
          icon={Trophy}
          title="Open the first match pick"
          description="Create a two-choice match card, then the pick screen turns into the community split and personal pick history."
          items={[
            { label: 'Pick card', detail: 'One match label with two clear sides.', badge: 'open', tone: 'info' },
            { label: 'Community split', detail: 'Votes become percentages once people pick.', badge: 'live', tone: 'success' },
            { label: 'History', detail: 'Resolved picks become a personal result log.', badge: 'track' },
          ]}
          action={(
            <Button type="button" variant="primary" onClick={() => void createPrompt()} disabled={!canCreatePrompt} loading={busy}>
              Open pick
            </Button>
          )}
        >
          <Container layout="grid" gridCols={3} gap="sm">
            <Input placeholder="Match card" value={promptLabel} onChange={(event) => setPromptLabel(event.currentTarget.value)} />
            <Input placeholder="Choice A" value={choiceA} onChange={(event) => setChoiceA(event.currentTarget.value)} />
            <Input placeholder="Choice B" value={choiceB} onChange={(event) => setChoiceB(event.currentTarget.value)} />
          </Container>
          <WorkSkeletonRows rows={2} />
        </WorkStartState>
      ) : null}
      {message ? (
        <Text variant="body-xs" color={message.endsWith('saved.') || message.endsWith('opened.') ? 'success' : 'warning'}>
          {message}
        </Text>
      ) : null}
      {views.length > 0 ? (
      <Container layout="grid" gridCols={2} gap="md">
        <Container layout="vertical" gap="xs">
          {views.map((view) => (
            <Button
              key={view.match.matchId}
              type="button"
              variant="secondary"
              active={view.match.matchId === selected?.match.matchId}
              onClick={() => setSelectedMatchId(view.match.matchId)}
            >
              {view.match.label}
            </Button>
          ))}
        </Container>
        {selected ? (
          <Container layout="vertical" gap="md">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="heading-lg" leading="tight">{selected.match.label}</Text>
                <Text variant="body-xs" color="faint">Community pick split</Text>
              </Container>
              <Badge variant={selected.result ? 'success' : 'info'} size="lg">
                {selected.result ? 'Resolved' : 'Open'}
              </Badge>
            </Container>
            {selected.choices.map((choice) => (
              <Card key={choice.choiceId} variant="nested" padding="md">
                <Container layout="horizontal" gap="sm" justifyContent="between" alignItems="center" wrap>
                  <Container layout="vertical" gap="xs">
                    <Text variant="body" weight="semibold">
                      {choice.label}
                    </Text>
                    <Text variant="caption" color="faint">
                      {choice.pickCount} picks / {choice.percentPicked}%
                    </Text>
                  </Container>
                  <Container layout="horizontal" gap="xs" alignItems="center" wrap>
                    {choice.selectedByUser ? <Badge variant="info" size="sm">Your pick</Badge> : null}
                    {choice.winner ? <Badge variant="success" size="sm">Winner</Badge> : null}
                    <Button type="button" size="sm" variant="primary" onClick={() => void pick(choice.choiceId)} disabled={Boolean(selected.result)}>
                      Pick winner
                    </Button>
                  </Container>
                </Container>
              </Card>
            ))}
            <Text variant="body-xs" color="faint">{selected.totalPicks} total picks</Text>
            {selected.result ? <Text variant="body">{selected.result.summary}</Text> : null}
            {history.length > 0 ? (
              <Container layout="vertical" gap="xs">
                <Text variant="heading">Your picks</Text>
                {history.slice(0, 4).map((entry) => (
                  <Text key={entry.pick.pickId} variant="body" color="muted">
                    {entry.matchLabel}: {entry.choiceLabel}{entry.correct === undefined ? '' : entry.correct ? ' - correct' : ' - missed'}
                  </Text>
                ))}
              </Container>
            ) : (
              <WorkStartState
                icon={Users}
                title="Your pick history starts after your first pick"
                description="The history row stays quiet until this profile has a saved pick or resolved result."
              />
            )}
          </Container>
        ) : null}
      </Container>
      ) : null}
    </Container>
  );
}
