import * as React from 'react';
import { Brain, Eye } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildRequestReviewResponseInput,
  requestReviewResponse,
} from '@/packages/spaced-repetition/do-work/request-review-response';
import { readSpacedRepetitionState } from '@/packages/spaced-repetition/read-data/read-spaced-repetition';
import { dueQueueFromResponses } from '@/packages/spaced-repetition/read-data/project-due-from-responses';
import { reviewGradeButtons } from '@/packages/spaced-repetition/read-data/schedule-next-review';

type SpacedRepetitionSurfaceProps = {
  learnerId?: string;
  responseTarget?: string;
};

// The review buttons come from DATA (the policy's grade tokens + label map) —
// this surface enumerates no grade. A new grade button appears by adding a
// `gradeQuality` policy row, with zero edits here (enum dissolution).
const gradeButtons = reviewGradeButtons();

export function SpacedRepetitionSurface({ learnerId, responseTarget }: SpacedRepetitionSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readSpacedRepetitionState(rows), [rows]);
  // Due-ness is DERIVED from response history (responses are the SSOT): fold each
  // prompt's responses through the scheduler at the current time. Read-time clock
  // is a host concern, so Date.now() here is legitimate (the core stays pure).
  const queue = React.useMemo(
    () => dueQueueFromResponses(state.prompts, state.responses, Date.now(), undefined, learnerId).filter((s) => s.isDue),
    [state, learnerId],
  );
  const [selectedPromptId, setSelectedPromptId] = React.useState<string | undefined>();
  const [answerVisible, setAnswerVisible] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = queue.find((item) => item.prompt.promptId === selectedPromptId) ?? queue[0];

  React.useEffect(() => {
    if (!selectedPromptId && queue[0]) setSelectedPromptId(queue[0].prompt.promptId);
  }, [queue, selectedPromptId]);

  const submitResponse = React.useCallback(async (response: string) => {
    if (!learnerId || !selected || !responseTarget) {
      setMessage('Choose a review first.');
      return;
    }
    await requestReviewResponse(buildRequestReviewResponseInput({
      learnerId,
      promptId: selected.prompt.promptId,
      target: responseTarget,
      response,
    }));
    setMessage('Review saved.');
  }, [learnerId, responseTarget, selected]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Review Queue</Text>
      {message ? <Text variant="body-xs" color="success">{message}</Text> : null}
      {queue.length === 0 ? (
        <WorkStartState
          icon={Brain}
          title="Review queue is caught up"
          description="Due cards appear here when prompts and schedules are published for this learner. The queue will show the prompt, answer reveal, and difficulty buttons."
          items={[
            { label: 'Prompt', detail: 'The recall card due for review.', badge: 'card', tone: 'info' },
            { label: 'Reveal', detail: 'Answer stays hidden until the learner checks it.', badge: 'show' },
            { label: 'Rating', detail: `${gradeButtons.map((g) => g.label).join(', ')} update the schedule.`, badge: 'review', tone: 'success' },
          ]}
        >
          <WorkSkeletonRows rows={3} />
        </WorkStartState>
      ) : null}
      {queue.length > 0 ? (
      <Container layout="grid" gridCols={2} gap="md">
        <Container layout="vertical" gap="xs">
          {queue.map((item) => (
            <Button
              key={item.prompt.promptId}
              type="button"
              variant="secondary"
              active={item.prompt.promptId === selected?.prompt.promptId}
              onClick={() => {
                setSelectedPromptId(item.prompt.promptId);
                setAnswerVisible(false);
              }}
            >
              {item.prompt.label ?? item.prompt.prompt}
            </Button>
          ))}
        </Container>
        {selected ? (
          <Container layout="vertical" gap="md">
            <Card variant="nested" padding="md">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="heading-lg" leading="tight">{selected.prompt.prompt}</Text>
                  <Text variant="body-xs" color="faint">{selected.reviewCount === 0 ? 'New' : 'Due now'}</Text>
                </Container>
                <Badge variant="info" size="sm">Due</Badge>
              </Container>
            </Card>
            {answerVisible && selected.prompt.answer ? (
              <Card variant="nested" padding="md">
                <Text variant="body">{selected.prompt.answer}</Text>
              </Card>
            ) : null}
            {!answerVisible ? (
              <Button type="button" variant="primary" onClick={() => setAnswerVisible(true)}>
                <Eye aria-hidden="true" className="h-4 w-4" />
                Show answer
              </Button>
            ) : (
              <Container layout="horizontal" gap="xs" wrap>
                {gradeButtons.map((grade) => (
                  <Button key={grade.token} type="button" variant="primary" onClick={() => void submitResponse(grade.token)}>
                    {grade.label}
                  </Button>
                ))}
              </Container>
            )}
          </Container>
        ) : null}
      </Container>
      ) : null}
    </Container>
  );
}
