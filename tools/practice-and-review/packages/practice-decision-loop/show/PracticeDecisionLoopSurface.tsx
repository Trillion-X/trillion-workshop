import * as React from 'react';
import { ListChecks } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input, Textarea } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildCreateDecisionPromptInput,
  createDecisionPrompt,
} from '@/packages/practice-decision-loop/do-work/create-decision-prompt';
import {
  buildSubmitDecisionResponseInput,
  submitDecisionResponse,
} from '@/packages/practice-decision-loop/do-work/submit-decision-response';
import {
  promptViews,
  readPracticeDecisionState,
} from '@/packages/practice-decision-loop/read-data/read-practice-decision-loop';

type PracticeDecisionLoopSurfaceProps = {
  userId?: string;
};

export function PracticeDecisionLoopSurface({ userId }: PracticeDecisionLoopSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readPracticeDecisionState(rows), [rows]);
  const views = React.useMemo(() => promptViews(state), [state]);
  const first = React.useMemo(() => {
    if (!userId) return views[0];
    return views.find((view) => view.responses.every((response) => response.userId !== userId)) ?? views[0];
  }, [userId, views]);
  const [choiceId, setChoiceId] = React.useState<string>('');
  const [reasonText, setReasonText] = React.useState('');
  const [promptTitle, setPromptTitle] = React.useState('');
  const [promptBody, setPromptBody] = React.useState('');
  const [promptChoiceA, setPromptChoiceA] = React.useState('');
  const [promptChoiceB, setPromptChoiceB] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const canSubmit = Boolean(first && choiceId && userId && !busy);
  const canCreatePrompt = Boolean(promptTitle.trim() && promptBody.trim() && promptChoiceA.trim() && promptChoiceB.trim() && !creating);

  React.useEffect(() => {
    setChoiceId('');
    setReasonText('');
    setMessage(null);
  }, [first?.prompt.promptId]);

  const submit = React.useCallback(async () => {
    if (!first || !choiceId) {
      setMessage('Choose an answer first.');
      return;
    }
    if (!userId) {
      setMessage('Choose your profile before answering.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await submitDecisionResponse(buildSubmitDecisionResponseInput({
        choiceId,
        promptId: first.prompt.promptId,
        reasonText,
        userId,
      }));
      setMessage('Answer sent.');
      setReasonText('');
    } catch {
      setMessage('Answer could not be sent.');
    } finally {
      setBusy(false);
    }
  }, [choiceId, first, reasonText, userId]);

  const createPrompt = React.useCallback(async () => {
    if (!canCreatePrompt) {
      setMessage('Add the question and two answers first.');
      return;
    }
    setCreating(true);
    setMessage(null);
    try {
      await createDecisionPrompt(buildCreateDecisionPromptInput({
        subjectKind: 'practice-decision',
        subjectLabel: promptTitle,
        evidenceKind: 'practice-question',
        evidenceSourceId: userId ?? 'source:practice-decision-loop',
        evidenceSourceLabel: 'Practice decision loop',
        evidencePayload: {
          title: promptTitle,
          body: promptBody,
        },
        promptKind: 'practice-choice',
        title: promptTitle,
        body: promptBody,
        choices: [
          { choiceId: 'choice:a', label: promptChoiceA },
          { choiceId: 'choice:b', label: promptChoiceB },
        ],
      }));
      setPromptTitle('');
      setPromptBody('');
      setPromptChoiceA('');
      setPromptChoiceB('');
      setMessage('Practice question opened.');
    } catch {
      setMessage('Practice question could not open.');
    } finally {
      setCreating(false);
    }
  }, [canCreatePrompt, promptBody, promptChoiceA, promptChoiceB, promptTitle, userId]);

  return (
    <Container layout="vertical" gap="sm">
      <Text variant="heading">Practice Decisions</Text>
      {message ? (
        <Text variant="body-xs" color={message.endsWith('sent.') || message.endsWith('opened.') ? 'success' : 'warning'}>
          {message}
        </Text>
      ) : null}
      {first ? (
        <Card variant="nested" padding="md">
        <Container layout="vertical" gap="md">
          <Container layout="vertical" gap="xs">
            <Text variant="heading-lg" leading="tight">{first.prompt.title}</Text>
            <Text variant="body" color="muted">{first.prompt.body}</Text>
          </Container>
          <Container layout="vertical" gap="xs">
            {first.prompt.choices.map((choice) => (
              <Button
                key={choice.choiceId}
                type="button"
                variant="secondary"
                active={choice.choiceId === choiceId}
                onClick={() => setChoiceId(choice.choiceId)}
              >
                {choice.label}
              </Button>
            ))}
          </Container>
          <Textarea
            placeholder="Why this answer?"
            rows={4}
            value={reasonText}
            onChange={(event) => setReasonText(event.currentTarget.value)}
          />
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
            {message ? (
              <Text variant="body-xs" color={message === 'Answer sent.' ? 'success' : 'warning'}>
                {message}
              </Text>
            ) : null}
            <Button type="button" variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>
              Submit answer
            </Button>
          </Container>
          {first.debrief ? (
            <Card variant="nested" padding="md">
              <Text variant="heading">{first.debrief.title}</Text>
              {first.debrief.points.map((point) => (
                <Text key={point} variant="body" color="muted">{point}</Text>
              ))}
            </Card>
          ) : null}
        </Container>
        </Card>
      ) : (
        <WorkStartState
          icon={ListChecks}
          title="Open the first practice decision"
          description="Create a two-choice practice question, then the loop can collect answers, reasons, and debrief points."
          items={[
            { label: 'Question', detail: 'One decision the player needs to make under pressure.', badge: 'prompt', tone: 'info' },
            { label: 'Choices', detail: 'Two concrete options, not vague advice.', badge: 'answer' },
            { label: 'Debrief', detail: 'Published results can explain why the choice mattered.', badge: 'review', tone: 'success' },
          ]}
          action={(
            <Button type="button" variant="primary" onClick={() => void createPrompt()} disabled={!canCreatePrompt} loading={creating}>
              Open question
            </Button>
          )}
        >
          <Container layout="grid" gridCols={2} gap="sm">
            <Input placeholder="Question title" value={promptTitle} onChange={(event) => setPromptTitle(event.currentTarget.value)} />
            <Input placeholder="Choice A" value={promptChoiceA} onChange={(event) => setPromptChoiceA(event.currentTarget.value)} />
            <Input placeholder="Choice B" value={promptChoiceB} onChange={(event) => setPromptChoiceB(event.currentTarget.value)} />
          </Container>
          <Textarea
            placeholder="Question body"
            rows={4}
            value={promptBody}
            onChange={(event) => setPromptBody(event.currentTarget.value)}
          />
          <WorkSkeletonRows rows={2} />
        </WorkStartState>
      )}
    </Container>
  );
}
