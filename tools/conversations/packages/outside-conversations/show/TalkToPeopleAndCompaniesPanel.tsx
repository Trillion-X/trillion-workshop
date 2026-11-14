import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import { Button, Container, Form, Text, Textarea } from '@/packages/ui';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import {
  startOutsideConversation,
  type OutsideConversationReceipt,
} from '@/packages/outside-conversations/do-work/request-outside-conversation-transition';
import {
  decodeOutsideConversationsSurface,
  type OutsideConversationsSurface,
  type WorkGraphRecord,
} from '@/packages/outside-conversations/read-data/read-outside-conversations';

export interface TalkToPeopleAndCompaniesPanelProps {
  rawData?: unknown;
  surface?: OutsideConversationsSurface;
}

function fieldText(record: WorkGraphRecord | undefined, key: string, fallback = ''): string {
  const value = record?.fields[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function itemRows(surface: OutsideConversationsSurface, receipts: readonly OutsideConversationReceipt[]): OneStepAtATimeItem[] {
  const receiptItems = receipts.slice(0, 2).map((receipt) => ({
    key: receipt.correlationRef,
    title: receipt.summary,
    detail: receipt.envelopeTarget,
    badge: receipt.visibleState,
    tone: 'info' as const,
  }));

  const recordItems = surface.records.slice(0, 4).map((record) => ({
    key: record.id,
    title: record.label,
    detail: fieldText(record, 'summary', record.typeId),
    badge: record.typeId,
    tone: 'neutral' as const,
  }));

  return [...receiptItems, ...recordItems];
}

export function TalkToPeopleAndCompaniesPanel({
  rawData,
  surface: surfaceProp,
}: TalkToPeopleAndCompaniesPanelProps) {
  const liveData = useBitfieldData();
  const [requestText, setRequestText] = React.useState('');
  const [receiptList, setReceiptList] = React.useState<OutsideConversationReceipt[]>([]);
  const [submitState, setSubmitState] = React.useState('idle');
  const surface = React.useMemo(
    () => surfaceProp ?? decodeOutsideConversationsSurface(rawData ?? liveData),
    [liveData, rawData, surfaceProp],
  );
  const latestReceipt = receiptList[0] ?? null;
  const primaryAction = surface.actions.find((action) => action.primary) ?? surface.actions[0];
  const focus = surface.records[0];
  const issueText = surface.proof.issues[0];

  function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = requestText.trim();
    if (!trimmed || !primaryAction || submitState === 'submitting') return;

    setSubmitState('submitting');
    startOutsideConversation({
      action: primaryAction,
      requestText: trimmed,
      values: { summary: trimmed },
    })
      .then((receipt) => {
        React.startTransition(() => {
          setReceiptList((current) => [receipt, ...current].slice(0, 3));
          setRequestText('');
          setSubmitState('submitted');
        });
      })
      .catch((error) => {
        console.error('[outside-conversations] failed to start descriptor action', error);
        setSubmitState('error');
      });
  }

  const statusLabel = submitState === 'error'
    ? 'Needs attention'
    : latestReceipt?.visibleState ?? (issueText ? 'Needs attention' : surface.graph.label);
  const statusTone = submitState === 'error' || issueText ? 'warning' : latestReceipt ? 'info' : 'muted';

  return (
    <OneStepAtATimeSurface
      eyebrow="Outside world"
      title="Talk to people and companies."
      description="Describe what you need to happen with a person or company, then save it as a request."
      status={statusLabel}
      statusTone={statusTone}
      primaryValue={latestReceipt ? 'Saved' : 'Ready'}
      primaryLabel={latestReceipt?.summary ?? fieldText(focus, 'summary', 'No request yet.')}
      primaryDetail={undefined}
      nextStep={issueText ?? 'Describe the outcome below, then save it.'}
      itemsTitle="Your requests"
      items={itemRows(surface, receiptList)}
      emptyTitle="No requests yet"
      emptyDetail="Start by describing what you need once."
      detailsTitle="Details"
      details={(
        <Container layout="vertical" gap="sm">
          <Text variant="body-xs" color="faint" wrap="preserve">
            {surface.records.length} saved · {receiptList.length} sent this session
          </Text>
        </Container>
      )}
    >
      <Form onSubmit={submitRequest}>
        <Container layout="vertical" gap="sm">
          <Textarea
            label="What should be handled?"
            value={requestText}
            onChange={(event) => {
              setRequestText(event.currentTarget.value);
              if (submitState !== 'idle') setSubmitState('idle');
            }}
            placeholder="Describe the outcome and proof you need."
            rows={5}
          />
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
            <Text variant="body-xs" color={submitState === 'error' ? 'error' : 'faint'} leading="relaxed">
              {primaryAction ? 'Your request is saved before anything else happens.' : 'Saving is not set up yet.'}
            </Text>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={!requestText.trim() || !primaryAction || submitState === 'submitting'}
              loading={submitState === 'submitting'}
            >
              {submitState === 'submitting' ? 'Saving' : primaryAction?.label ?? 'Unavailable'}
            </Button>
          </Container>
        </Container>
      </Form>
    </OneStepAtATimeSurface>
  );
}
