import * as React from 'react';
import { BarChart3 } from 'lucide-react';
import { useBitfieldData } from '@/packages/content-analytics/.bitfield-entry-scope/content-analytics/runtime-kit-react';

import {
  readContentAnalyticsModel,
  type ContentAnalyticsModel,
  type ReadContentAnalyticsModelInput,
} from '@/packages/content-analytics/read-data/content-analytics-model';
import {
  invokeContentAnalyticsAction,
  type ContentAnalyticsTargetSender,
} from '@/packages/content-analytics/do-work/content-analytics-actions';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import { Button } from '@/packages/ui/show/button';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { WorkSkeletonRows, WorkStartState } from '@/packages/ui/show/work-start-state';

export type ContentAnalyticsPanelProps = {
  modelInput?: ReadContentAnalyticsModelInput;
  model?: ContentAnalyticsModel;
  sendTargetRequest?: ContentAnalyticsTargetSender;
};

function itemsFor(model: ContentAnalyticsModel): OneStepAtATimeItem[] {
  return model.items.map((item) => ({
    key: item.id,
    title: item.title,
    detail: item.detail,
    badge: item.badge,
    tone: 'neutral',
  }));
}

function Details({ model }: { model: ContentAnalyticsModel }) {
  return (
    <Container layout="vertical" gap="sm">
      {model.blockers.map((blocker, index) => (
        <Text key={`${blocker.code ?? 'blocker'}-${index}`} variant="body-xs" color="warning">
          {blocker.message ?? 'This result is not ready yet.'}
        </Text>
      ))}
      {model.details.map((detail) => (
        <Text key={detail.fieldId} variant="body-xs" color="faint" wrap="preserve">
          {detail.label}: {detail.text}
        </Text>
      ))}
    </Container>
  );
}

function ActionStrip({
  model,
  sender,
}: {
  model: ContentAnalyticsModel;
  sender?: ContentAnalyticsTargetSender;
}) {
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = model.items[0] ?? null;
  const action = model.actions[0];
  if (!action) return null;

  return (
    <Container layout="vertical" gap="xs">
      <Button
        type="button"
        variant="primary"
        size="md"
        disabled={action.blocked || !selected}
        onClick={async () => {
          setMessage(null);
          try {
            await invokeContentAnalyticsAction(action, { selected }, sender);
            setMessage('Saved.');
          } catch (error) {
            const raw = error instanceof Error ? error.message : String(error); console.error("[content-analytics] request failed:", raw); setMessage("The request failed.");
          }
        }}
      >
        {action.label}
      </Button>
      {action.blockedReason ? (
        <Text variant="body-xs" color="warning">
          {action.blockedReason}
        </Text>
      ) : null}
      {message ? (
        <Text variant="body-xs" color={message === 'Saved.' ? 'success' : 'error'}>
          {message}
        </Text>
      ) : null}
    </Container>
  );
}

export function ContentAnalyticsPanel({
  modelInput,
  model: suppliedModel,
  sendTargetRequest,
}: ContentAnalyticsPanelProps) {
  const evidenceRows = useBitfieldData('content-analytics:contentMediaEvidence');
  const model = React.useMemo(
    () => suppliedModel ?? readContentAnalyticsModel(modelInput ?? { rows: evidenceRows }),
    [evidenceRows, modelInput, suppliedModel],
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('content-analytics:model-rendered', {
      detail: { revision: model.revision },
    }));
  }, [model.revision]);

  return (
    <OneStepAtATimeSurface
      density="compact"
      eyebrow={model.eyebrow}
      title={model.title}
      status={model.status}
      statusTone={model.statusTone}
      primaryValue={model.primary.value}
      primaryLabel={model.primary.label}
      primaryDetail={model.primary.detail}
      action={<ActionStrip model={model} sender={sendTargetRequest} />}
      itemsTitle={model.itemsTitle}
      items={itemsFor(model)}
      emptyTitle={model.empty.title}
      emptyDetail={model.empty.detail}
      detailsTitle={model.detailsTitle}
      details={<Details model={model} />}
    >
      {model.items.length === 0 ? (
        <WorkStartState
          icon={BarChart3}
          title="Results are waiting for a finished post"
          description="When a connected post or channel reports results, this panel becomes the latest-result list, blockers, and source details."
          items={[
            { label: 'Source', detail: 'A finished post or channel result.', badge: 'required', tone: 'info' },
            { label: 'Latest results', detail: 'Rows become compact result cards instead of a hero empty state.', badge: 'list' },
            { label: 'Blockers', detail: 'Missing permissions or sources stay visible without hiding the rest.', badge: 'guard', tone: 'warning' },
          ]}
        >
          <WorkSkeletonRows rows={2} />
        </WorkStartState>
      ) : null}
    </OneStepAtATimeSurface>
  );
}
