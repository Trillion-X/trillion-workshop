import * as React from 'react';
import { ClipboardCheck, PlayCircle } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';
import {
  buildRequestProtocolEventInput,
  requestProtocolEvent,
} from '@/packages/practice-protocol/do-work/request-protocol-event';
import {
  practiceProtocolViews,
  readPracticeProtocolState,
} from '@/packages/practice-protocol/read-data/read-practice-protocol';

type PracticeProtocolSurfaceProps = {
  learnerId?: string;
  eventTarget?: string;
};

export function PracticeProtocolSurface({ learnerId, eventTarget }: PracticeProtocolSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readPracticeProtocolState(rows), [rows]);
  const views = React.useMemo(() => practiceProtocolViews(state, learnerId), [state, learnerId]);
  const [selectedProtocolId, setSelectedProtocolId] = React.useState<string | undefined>();
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = views.find((view) => view.protocol.protocolId === selectedProtocolId) ?? views[0];

  React.useEffect(() => {
    if (!selectedProtocolId && views[0]) setSelectedProtocolId(views[0].protocol.protocolId);
  }, [selectedProtocolId, views]);

  const requestStep = React.useCallback(async () => {
    if (!learnerId || !selected?.currentStep || !eventTarget) {
      setMessage('Choose a practice step first.');
      return;
    }
    await requestProtocolEvent(buildRequestProtocolEventInput({
      learnerId,
      protocolId: selected.protocol.protocolId,
      stepId: selected.currentStep.stepId,
      target: eventTarget,
      event: { action: 'start-step' },
    }));
    setMessage('Practice step opened.');
  }, [eventTarget, learnerId, selected]);

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Practice Protocol</Text>
      {message ? <Text variant="body-xs" color="success">{message}</Text> : null}
      {views.length === 0 ? (
        <WorkStartState
          icon={ClipboardCheck}
          title="Practice protocols are waiting for a plan"
          description="When a protocol is published, this screen becomes the ordered drill checklist, current cue, evidence requirement, and step launcher."
          items={[
            { label: 'Protocol', detail: 'The plan name and summary.', badge: 'plan', tone: 'info' },
            { label: 'Steps', detail: 'Ordered cues with evidence requirements.', badge: 'drills' },
            { label: 'Launcher', detail: 'Start-step events open the selected practice target.', badge: 'start', tone: 'success' },
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
              key={view.protocol.protocolId}
              type="button"
              variant="secondary"
              active={view.protocol.protocolId === selected?.protocol.protocolId}
              onClick={() => setSelectedProtocolId(view.protocol.protocolId)}
            >
              {view.protocol.label}
            </Button>
          ))}
        </Container>
        {selected ? (
          <Container layout="vertical" gap="md">
            <Card variant="nested" padding="md">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="heading-lg" leading="tight">{selected.currentStep?.label ?? selected.protocol.label}</Text>
                  {selected.currentStep?.cue ? <Text variant="body" color="muted">{selected.currentStep.cue}</Text> : null}
                  {selected.currentStep?.evidenceNeeded ? <Text variant="body-xs" color="faint">{selected.currentStep.evidenceNeeded}</Text> : null}
                </Container>
                <Badge variant="info" size="sm">{selected.completedCount}/{selected.totalSteps}</Badge>
              </Container>
            </Card>
            <Card variant="nested" padding="md">
            <Container layout="vertical" gap="xs">
              {selected.steps.map((step) => (
                <Text key={step.stepId} variant="body-xs" color={selected.state?.completedStepIds.includes(step.stepId) ? 'success' : 'muted'}>
                  {step.label}
                </Text>
              ))}
            </Container>
            </Card>
            <Button type="button" variant="primary" onClick={() => void requestStep()}>
              <PlayCircle aria-hidden="true" className="h-4 w-4" />
              Start step
            </Button>
          </Container>
        ) : null}
      </Container>
      ) : null}
    </Container>
  );
}
