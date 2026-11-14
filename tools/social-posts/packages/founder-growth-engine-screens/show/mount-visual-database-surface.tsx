import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Container, ErrorBoundary, FloatingMaterialFrame, Text, mountReactSurface } from '@/packages/ui';
import { RecordSurfaceActions } from '@/packages/ui/show/placeable-surface-intent/RecordSurfaceActions';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import {
  buildFounderGrowthVisualDatabaseProjection,
  readFounderGrowthFeedInputName,
} from '@/packages/founder-growth-engine-screens/read-data/visual-database-projection';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function Surface({ surfaceInput }: { surfaceInput: unknown }) {
  const feed = useBitfieldData<unknown>(readFounderGrowthFeedInputName(surfaceInput) ?? 'founder-growth-next-moves-feed');
  const [projection, setProjection] = React.useState<Awaited<ReturnType<typeof buildFounderGrowthVisualDatabaseProjection>>>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    let cancelled = false;
    setProjection(undefined);
    setError(undefined);
    buildFounderGrowthVisualDatabaseProjection(surfaceInput, feed, async (target, request) => {
      const reply = await sendRequestToBitfieldTarget({ target, payload: request });
      return reply.payload ? JSON.parse(new TextDecoder().decode(reply.payload)) : null;
    }).then((value) => { if (!cancelled) setProjection(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load this view.'); });
    return () => { cancelled = true; };
  }, [feed, surfaceInput]);
  if (error) return <Text color="danger">{error}</Text>;
  if (!projection) return <Text color="muted">Loading…</Text>;
  return <Container layout="vertical" gap="md">
    <VisualDatabaseSurface
      model={projection.model}
      evaluatorDescriptors={projection.evaluatorDescriptors}
      initialViewId={projection.initialViewId}
    />
    {projection.openRows ? <RecordSurfaceActions
      records={projection.model.records.map((record) => record.raw)}
      intentPath={projection.openRows.intentPath}
      allowList={projection.openRows.allowList}
    /> : null}
  </Container>;
}

export default function mount({ el, props = {} }: MountArgs) {
  const surfaceInput = props.surfaceInput ?? props.surface_input;
  return mountReactSurface(el, <FloatingMaterialFrame frame={props.floating_frame}>
    <ErrorBoundary zoneName="founder growth visual database material">
      <Surface surfaceInput={surfaceInput} />
    </ErrorBoundary>
  </FloatingMaterialFrame>);
}
