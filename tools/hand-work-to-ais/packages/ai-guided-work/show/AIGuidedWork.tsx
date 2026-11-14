import React, { useCallback } from 'react';
import { Bot, Route, Sparkles } from 'lucide-react';
import { Badge, Button, Card, Container, Divider, Form, Icon, Input, Text, Textarea } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  startAIGuidedWork,
  type AIGuidedWorkReceipt,
} from '@/packages/ai-guided-work/do-work/start-ai-guided-work';
import { decodeAIGuidedWorkSurface } from '@/packages/ai-guided-work/read-data/read-ai-guided-work';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Container layout="horizontal" alignItems="start" justifyContent="between" gap="sm" padding="none">
      <Text variant="caption" color="faint">{label}</Text>
      <Text variant="caption" color="muted">{value}</Text>
    </Container>
  );
}

export function AIGuidedWork() {
  const raw = useBitfieldData();
  const surface = React.useMemo(() => decodeAIGuidedWorkSurface(raw), [raw]);
  const [subject, setSubject] = React.useState('');
  const [repeatInstruction, setRepeatInstruction] = React.useState('');
  const [submitState, setSubmitState] = React.useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [receipts, setReceipts] = React.useState<AIGuidedWorkReceipt[]>([]);
  const focus = surface.focus;

  const submit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanSubject = subject.trim();
    const cleanRepeatInstruction = repeatInstruction.trim();
    if (!cleanSubject || !cleanRepeatInstruction || submitState === 'submitting') return;
    setSubmitState('submitting');
    startAIGuidedWork({
      repeatInstruction: cleanRepeatInstruction,
      subject: cleanSubject,
    })
      .then((receipt) => {
        setReceipts((current) => [receipt, ...current].slice(0, 3));
        setSubject('');
        setRepeatInstruction('');
        setSubmitState('submitted');
      })
      .catch((err) => {
        console.error('[AIGuidedWork] Failed to start guided work:', err);
        setSubmitState('error');
      });
  }, [repeatInstruction, subject, submitState]);

  const latestReceipt = receipts[0];

  return (
    <Card variant="surface" padding="md">
      <Container layout="horizontal" alignItems="center" justifyContent="space-between" gap="md">
        <Container layout="horizontal" alignItems="center" gap="sm">
          <Icon icon={Sparkles} size="sm" />
          <Text variant="label">AI Guided Work</Text>
          <Badge variant={focus ? 'success' : 'neutral'}>{focus ? 'Active' : 'Ready'}</Badge>
        </Container>
        <Text variant="caption" color="faint">
          {surface.sessionCount} guides · {surface.claimCount} claims
        </Text>
      </Container>

      <Divider />

      <Form onSubmit={submit}>
        <Container layout="vertical" gap="sm" padding="none">
          <Textarea
            label="What should the AI keep helping you dig into?"
            value={subject}
            onChange={(event) => {
              setSubject(event.currentTarget.value);
              if (submitState !== 'idle') setSubmitState('idle');
            }}
            placeholder="Example: Keep pushing me deeper into tennis footwork."
            rows={3}
          />
          <Input
            label="When should it come back?"
            value={repeatInstruction}
            onChange={(event) => {
              setRepeatInstruction(event.currentTarget.value);
              if (submitState !== 'idle') setSubmitState('idle');
            }}
            placeholder="Example: every morning, or whenever I finish a study session"
          />
          <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm" padding="none">
            <Text variant="caption" color={submitState === 'error' ? 'error' : 'faint'}>
              {submitState === 'submitted'
                ? 'Guide started. A learning session is ready.'
                : submitState === 'error'
                  ? 'The guide was not started.'
                  : 'This starts the guide and creates a linked learning session.'}
            </Text>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!subject.trim() || !repeatInstruction.trim() || submitState === 'submitting'}
              loading={submitState === 'submitting'}
            >
              {submitState === 'submitting' ? 'Starting' : 'Start Repeating Guide'}
            </Button>
          </Container>
        </Container>
      </Form>

      {latestReceipt ? (
        <>
          <Divider />
          <Container layout="vertical" gap="xs" padding="none">
            <Container layout="horizontal" alignItems="center" gap="sm">
              <Icon icon={Route} size="xs" />
              <Text variant="label">Started guide</Text>
              <Badge variant="success">Started</Badge>
            </Container>
            <Container layout="vertical" gap="xs" padding="sm" border="all" background="overlay">
              <DetailRow label="Subject" value={latestReceipt.subject} />
              <DetailRow label="Comes back" value={latestReceipt.repeatInstruction} />
              <DetailRow label="Learning session" value={latestReceipt.learningSessionRef} />
              <DetailRow label="Guide session" value={latestReceipt.guideSessionRef} />
            </Container>
          </Container>
        </>
      ) : null}

      {focus ? (
        <>
          <Divider />
          <Container layout="vertical" gap="xs" padding="none">
            <Container layout="horizontal" alignItems="center" gap="sm">
              <Icon icon={Bot} size="xs" />
              <Text variant="body">{focus.operation.display.title}</Text>
              <Badge variant="info">{focus.operation.ownerPackage}</Badge>
            </Container>
            <Text variant="caption" color="muted">{focus.operation.display.status}</Text>
            {focus.session ? (
              <>
                <DetailRow label="Comes back" value={focus.session.repeatInstruction} />
                <DetailRow label="Learning session" value={focus.session.learningSessionRef} />
              </>
            ) : null}
          </Container>
        </>
      ) : null}
    </Card>
  );
}
