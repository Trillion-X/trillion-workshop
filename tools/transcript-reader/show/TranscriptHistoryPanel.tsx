import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import {
  readTranscriptHistoryRecordGraph,
  type ReadTranscriptHistoryGraphInput,
  type TranscriptHistoryModel,
} from '@/packages/transcript-history/read-data/transcript-history-record-graph';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

export type TranscriptHistoryPanelProps = {
  modelInput?: ReadTranscriptHistoryGraphInput;
  model?: TranscriptHistoryModel;
};

function modelItems(model: TranscriptHistoryModel): OneStepAtATimeItem[] {
  return model.items.map((item) => ({
    key: item.id,
    title: item.title,
    detail: item.detail,
    badge: item.badge,
    tone: 'neutral',
  }));
}

function Details({ model }: { model: TranscriptHistoryModel }) {
  return (
    <Container layout="vertical" gap="sm">
      {model.blockers.map((blocker, index) => (
        <Text key={`blocker-${index}`} variant="body-xs" color="warning">
          {blocker.message ?? 'Live material is not ready yet.'}
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

export function TranscriptHistoryPanel({
  modelInput,
  model: suppliedModel,
}: TranscriptHistoryPanelProps) {
  const evidenceRows = useBitfieldData('contentMediaEvidence');
  const model = React.useMemo(
    () => suppliedModel ?? readTranscriptHistoryRecordGraph(modelInput ?? { rows: evidenceRows }),
    [evidenceRows, modelInput, suppliedModel],
  );

  return (
    <OneStepAtATimeSurface
      eyebrow={model.eyebrow}
      title={model.title}
      status={model.status}
      statusTone={model.statusTone}
      primaryValue={model.primary.value}
      primaryLabel={model.primary.label}
      primaryDetail={model.primary.detail}
      itemsTitle={model.itemsTitle}
      items={modelItems(model)}
      emptyTitle={model.empty.title}
      emptyDetail={model.empty.detail}
      detailsTitle={model.detailsTitle}
      details={<Details model={model} />}
    />
  );
}
