// package-set://bitfield-studio/packages/ideas/show/mount-ideas.tsx

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { decodeIdeasWorkGraph } from '@/packages/ideas/read-data/read-ideas';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function IdeasRecordWorkSurface() {
  const records = useBitfieldData<unknown>('record-work');
  const fields = useBitfieldData<unknown>('fields');
  const views = useBitfieldData<unknown>('views');
  const actions = useBitfieldData<unknown>('actions');
  const relationships = useBitfieldData<unknown>('relationships');
  const operationLinks = useBitfieldData<unknown>('operation-links');
  const processSessionLinks = useBitfieldData<unknown>('process-session-links');
  const graph = React.useMemo(() => decodeIdeasWorkGraph({
    records,
    fields,
    views,
    actions,
    relationships,
    operationLinks,
    processSessionLinks,
  }), [records, fields, views, actions, relationships, operationLinks, processSessionLinks]);

  return <VisualDatabaseSurface model={graph.model} />;
}

function IdeasMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ideas material">
        <IdeasRecordWorkSurface />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <IdeasMaterial props={props} />);
}
