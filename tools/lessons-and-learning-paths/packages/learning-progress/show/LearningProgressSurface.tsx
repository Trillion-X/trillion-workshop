import * as React from 'react';
import { Activity, Target } from 'lucide-react';
import { newRunKey, runWorkshopTool } from '#workspace/workshop-tool-api';
import { Badge, Button, Card, Container, ProgressBar, Text, WorkSkeletonRows, WorkStartState } from '../../../../ui';
import { learningProgressViews } from '../../../do-work/learning-progress.mjs';
import { readLearningProgressState } from '../read-data/read-learning-progress';
import { useProgressRows } from './use-progress-rows';

type LearningProgressSurfaceProps = {
  learnerId?: string;
  practiceAction?: {
    tool: string;
    payload?: Record<string, unknown>;
    label?: string;
  };
};

export function LearningProgressSurface({ learnerId, practiceAction }: LearningProgressSurfaceProps) {
  const rows = useProgressRows();
  const state = React.useMemo(() => readLearningProgressState(rows), [rows]);
  const views = React.useMemo(() => learningProgressViews(state, learnerId), [state, learnerId]);
  const [selectedTrackId, setSelectedTrackId] = React.useState<string | undefined>();
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = views.find((view) => view.track.trackId === selectedTrackId) ?? views[0];

  React.useEffect(() => {
    if (!selectedTrackId && views[0]) setSelectedTrackId(views[0].track.trackId);
  }, [selectedTrackId, views]);

  const startFocus = React.useCallback(async () => {
    if (!learnerId || !selected?.currentStep || !practiceAction?.tool) {
      setMessage('Choose a focus first.');
      return;
    }
    await runWorkshopTool(practiceAction.tool, {
      ...(practiceAction.payload ?? {}),
      learner_id: learnerId,
      track_id: selected.track.trackId,
      step_id: selected.currentStep.stepId,
    }, newRunKey('practice'));
    setMessage('Next practice opened.');
  }, [learnerId, practiceAction, selected]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Learning Progress</Text>
      {message ? <Text variant="body-xs" color="success">{message}</Text> : null}
      {views.length === 0 ? (
        <WorkStartState
          icon={Target}
          title="Learning tracks are waiting for a focus plan"
          description="Once a focus track is published, this screen becomes the current step, progress bar, evidence feed, and next-practice launch point."
          items={[
            { label: 'Focus track', detail: 'The skill path the learner is following.', badge: 'track', tone: 'info' },
            { label: 'Steps', detail: 'Ordered practice targets with cues and evidence labels.', badge: 'steps' },
            { label: 'Evidence', detail: 'Recent results prove which steps are moving.', badge: 'proof', tone: 'success' },
          ]}
        >
          <WorkSkeletonRows rows={3} />
        </WorkStartState>
      ) : null}
      {views.length > 0 ? (
      <Container layout="grid" gridCols={2} gap="md">
        <Container layout="vertical" gap="xs">
          {views.map((view) => (
            <Button
              key={view.track.trackId}
              type="button"
              variant="secondary"
              active={view.track.trackId === selected?.track.trackId}
              onClick={() => setSelectedTrackId(view.track.trackId)}
            >
              {view.track.label}
            </Button>
          ))}
        </Container>
        {selected ? (
          <Container layout="vertical" gap="md">
            <Card variant="nested" padding="md">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="heading-lg" leading="tight">{selected.currentStep?.label ?? selected.track.label}</Text>
                  {selected.currentStep?.cue ? <Text variant="body" color="muted">{selected.currentStep.cue}</Text> : null}
                  <Text variant="body-xs" color="faint">{selected.statusLabel}</Text>
                </Container>
                <Badge variant={selected.percent >= 100 ? 'success' : 'info'} size="sm">
                  {selected.percent}%
                </Badge>
              </Container>
              <ProgressBar percentage={selected.percent} color="var(--accent-purple)" />
              <Text variant="body-xs" color="faint">{selected.completedCount} of {selected.totalSteps} steps complete</Text>
            </Card>
            <Card variant="nested" padding="md">
            <Container layout="horizontal" gap="xs" wrap>
              {selected.steps.map((step) => (
                <Text key={step.stepId} variant="body-xs" color={selected.state?.completedStepIds.includes(step.stepId) ? 'success' : 'muted'}>
                  {step.label}
                </Text>
              ))}
            </Container>
            </Card>
            <Button type="button" variant="primary" onClick={() => void startFocus()} disabled={!practiceAction?.tool}>
              {practiceAction?.label ?? 'Start next practice'}
            </Button>
            <Card variant="nested" padding="md">
              <Text variant="body" color="muted">Recent evidence</Text>
              {selected.recentEvidence.length === 0 ? (
                <WorkStartState
                  icon={Activity}
                  title="Evidence will attach here"
                  description="Completed practice, match proof, and notes become the recent evidence list for this focus."
                />
              ) : null}
              {selected.recentEvidence.map((item) => (
                <Text key={item.evidenceId} variant="body-xs">{item.label}</Text>
              ))}
            </Card>
          </Container>
        ) : null}
      </Container>
      ) : null}
    </Container>
  );
}
