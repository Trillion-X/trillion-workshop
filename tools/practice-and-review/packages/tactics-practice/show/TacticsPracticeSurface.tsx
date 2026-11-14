import * as React from 'react';
import { Swords, Trophy } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input, Textarea } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildSubmitDecisionResponseInput,
  submitDecisionResponse,
} from '@/packages/practice-decision-loop/do-work/submit-decision-response';
import {
  buildCreateTacticsContestInput,
  createTacticsContest,
} from '@/packages/tactics-practice/do-work/create-tactics-contest';
import {
  dailyTacticsContestView,
  oneOnOneTacticsContestView,
  readTacticsPracticeState,
  seasonTournamentView,
} from '@/packages/tactics-practice/read-data/read-tactics-practice';
import { OneOnOneContestPanel } from '@/packages/tactics-practice/show/OneOnOneContestPanel';
import { PeerVoteSplit } from '@/packages/tactics-practice/show/PeerVoteSplit';
import { SeasonTournamentPanel } from '@/packages/tactics-practice/show/SeasonTournamentPanel';
import { TacticalRatingStandings } from '@/packages/tactics-practice/show/TacticalRatingStandings';

type TacticsPracticeSurfaceProps = {
  userId?: string;
};

function generated(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function TacticsPracticeSurface({ userId }: TacticsPracticeSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readTacticsPracticeState(rows), [rows]);
  const dailyView = React.useMemo(() => dailyTacticsContestView(state), [state]);
  const oneOnOneView = React.useMemo(() => oneOnOneTacticsContestView(state), [state]);
  const seasonView = React.useMemo(() => seasonTournamentView(state), [state]);

  const dailyScenario = React.useMemo(() => {
    return dailyView?.scenarios[0] ?? state.scenarios[0];
  }, [dailyView, state.scenarios]);
  const dailyPrompt = React.useMemo(() => {
    const promptRef = dailyScenario?.promptRef;
    return (
      state.genericPrompts.find((prompt) => prompt.promptId === promptRef) ??
      dailyView?.prompts[0] ??
      state.genericPrompts[0]
    );
  }, [dailyScenario, dailyView, state.genericPrompts]);

  const [choiceId, setChoiceId] = React.useState<string>('');
  const [reasonText, setReasonText] = React.useState('');
  const [starterTitle, setStarterTitle] = React.useState('');
  const [starterSituation, setStarterSituation] = React.useState('');
  const [starterChoiceA, setStarterChoiceA] = React.useState('');
  const [starterChoiceB, setStarterChoiceB] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [answered, setAnswered] = React.useState(false);
  const canSubmit = Boolean(dailyPrompt && choiceId && userId && !busy && !answered);
  const canCreateDaily = Boolean(starterTitle.trim() && starterSituation.trim() && starterChoiceA.trim() && starterChoiceB.trim() && !creating);

  React.useEffect(() => {
    setChoiceId('');
    setReasonText('');
    setMessage(null);
    setAnswered(false);
  }, [dailyPrompt?.promptId]);

  const selectedChoice = dailyPrompt?.choices.find((choice) => choice.choiceId === choiceId);

  const submit = React.useCallback(async () => {
    if (!dailyPrompt || !choiceId) {
      setMessage('Choose your tactic first.');
      return;
    }
    if (!userId) {
      setMessage('Choose your player profile before answering.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await submitDecisionResponse(buildSubmitDecisionResponseInput({
        choiceId,
        promptId: dailyPrompt.promptId,
        reasonText,
        userId,
      }));
      setMessage('Answer locked in.');
      setAnswered(true);
    } catch {
      setMessage('Answer could not be sent.');
    } finally {
      setBusy(false);
    }
  }, [choiceId, dailyPrompt, reasonText, userId]);

  const createDaily = React.useCallback(async () => {
    if (!canCreateDaily) {
      setMessage('Add the tactic, situation, and two choices first.');
      return;
    }
    setCreating(true);
    setMessage(null);
    try {
      await createTacticsContest(buildCreateTacticsContestInput({
        contestId: generated('tactics-contest'),
        configKind: 'daily-tactics-contest',
        label: 'Daily tactics',
        scenarioId: generated('tactics-scenario'),
        promptId: generated('decision-prompt'),
        evidenceId: generated('decision-evidence'),
        title: starterTitle,
        situation: starterSituation,
        choices: [
          { choiceId: 'choice:a', label: starterChoiceA },
          { choiceId: 'choice:b', label: starterChoiceB },
        ],
        courtZones: [],
        createdAt: new Date().toISOString(),
      }));
      setStarterTitle('');
      setStarterSituation('');
      setStarterChoiceA('');
      setStarterChoiceB('');
      setMessage('Daily tactic opened.');
    } catch {
      setMessage('Daily tactic could not open.');
    } finally {
      setCreating(false);
    }
  }, [canCreateDaily, starterChoiceA, starterChoiceB, starterSituation, starterTitle]);

  return (
    <Container layout="vertical" gap="lg">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="heading-xl">Tactics Tactics Practice</Text>
        <Badge variant={dailyPrompt ? 'success' : 'info'} size="sm">
          {dailyPrompt ? 'Active' : 'Setup'}
        </Badge>
      </Container>
      {message ? (
        <Text variant="body-xs" color={message.endsWith('in.') || message.endsWith('opened.') ? 'success' : 'warning'}>
          {message}
        </Text>
      ) : null}

      {dailyPrompt ? (
        <Card variant="nested" padding="md">
        <Container layout="vertical" gap="md">
          <Container layout="vertical" gap="xs">
            <Text variant="heading-lg" leading="tight">
              {dailyPrompt.title}
            </Text>
            <Text variant="body" color="muted">
              {dailyPrompt.body}
            </Text>
          </Container>

          <Container layout="vertical" gap="xs">
            {dailyPrompt.choices.map((choice) => (
              <Button
                key={choice.choiceId}
                type="button"
                variant="secondary"
                active={choice.choiceId === choiceId}
                disabled={answered}
                onClick={() => setChoiceId(choice.choiceId)}
              >
                {choice.label}
              </Button>
            ))}
          </Container>

          {answered ? (
            <Container layout="vertical" gap="xs" padding="sm">
              <Text variant="heading-xs" color="success">
                Your tactic is locked
              </Text>
              {selectedChoice ? (
                <Text variant="body-xs" color="strong">
                  You played: {selectedChoice.label}
                </Text>
              ) : null}
              {reasonText ? (
                <Text variant="caption" color="muted">
                  Your reason: {reasonText}
                </Text>
              ) : null}
            </Container>
          ) : (
            <Textarea
              placeholder="Why this tactic?"
              rows={4}
              value={reasonText}
              onChange={(event) => setReasonText(event.currentTarget.value)}
            />
          )}

          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
            {message ? (
              <Text variant="body-xs" color={message === 'Answer locked in.' ? 'success' : 'warning'}>
                {message}
              </Text>
            ) : null}
            {!answered ? (
              <Button type="button" variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>
                Submit tactic
              </Button>
            ) : null}
          </Container>

          {dailyView ? (
            <Container layout="vertical" gap="md">
              <PeerVoteSplit votes={dailyView.votes} viewerId={userId} />
              <TacticalRatingStandings effects={dailyView.ratingEffects} viewerId={userId} />
            </Container>
          ) : null}
        </Container>
        </Card>
      ) : (
        <WorkStartState
          icon={Swords}
          title="Open the daily tactic"
          description="Create the first tactical situation with two playable choices. Once it is open, the screen becomes the practice card, vote split, and rating feedback."
          items={[
            { label: 'Scenario', detail: 'Describe the point situation in tactics language.', badge: 'prompt', tone: 'info' },
            { label: 'Choices', detail: 'Two tactical options the player can commit to.', badge: 'decision' },
            { label: 'Feedback', detail: 'Responses can feed peer votes and tactical rating effects.', badge: 'rating', tone: 'success' },
          ]}
          action={(
            <Button type="button" variant="primary" onClick={() => void createDaily()} disabled={!canCreateDaily} loading={creating}>
              Open tactic
            </Button>
          )}
        >
          <Container layout="grid" gridCols={2} gap="sm">
            <Input placeholder="Tactic title" value={starterTitle} onChange={(event) => setStarterTitle(event.currentTarget.value)} />
            <Input placeholder="Choice A" value={starterChoiceA} onChange={(event) => setStarterChoiceA(event.currentTarget.value)} />
            <Input placeholder="Choice B" value={starterChoiceB} onChange={(event) => setStarterChoiceB(event.currentTarget.value)} />
          </Container>
          <Textarea
            placeholder="Point situation"
            rows={4}
            value={starterSituation}
            onChange={(event) => setStarterSituation(event.currentTarget.value)}
          />
          <WorkSkeletonRows rows={2} />
        </WorkStartState>
      )}

      {oneOnOneView ? (
        <OneOnOneContestPanel view={oneOnOneView} viewerId={userId} />
      ) : (
        <WorkStartState
          icon={Swords}
          title="One-on-one contest is not open yet"
          description="Daily tactics can run now; head-to-head contests appear here once a one-on-one contest record is opened."
        />
      )}

      {seasonView ? (
        <SeasonTournamentPanel view={seasonView} viewerId={userId} />
      ) : (
        <WorkStartState
          icon={Trophy}
          title="Season tournament is waiting for a season"
          description="When a season tournament is opened, this panel becomes divisions, bracket matches, weekly scenarios, and champion review."
        />
      )}
    </Container>
  );
}
