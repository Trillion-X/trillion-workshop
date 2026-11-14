// package-set://bitfield-studio/packages/research-workspace/show/mount-research-board.tsx
//
// Research board surface — REUSES visual-database's generic render primitive (declared public
// source) fed by research-workspace DATA. ZERO board logic owned here: the gathered videos
// feed (research-workspace-source-feed, {items:[...]}) is decoded by visual-database's
// decodeVisualDatabaseModel against research-workspace field/view descriptors and rendered by
// VisualDatabaseSurface. A different source kind = different DATA, same surface (L069/L090).
import React from 'react';
import { Card } from '@/packages/ui';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import { decodeVisualDatabaseModel } from '@/packages/visual-database/read-data/visual-database';
import { AddChannelPanel, type AddChannelConfig } from './AddChannelPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ResearchBoardPanel() {
  const records = useBitfieldData<unknown>('records');
  const fields = useBitfieldData<unknown>('fields');
  const views = useBitfieldData<unknown>('views');
  const model = React.useMemo(
    () => decodeVisualDatabaseModel({ records, fields, views, actions: undefined }),
    [records, fields, views],
  );
  return (
    <VisualDatabaseSurface
      model={model}
      onInvokeAction={() => {
        /* no board actions on the research board yet */
      }}
    />
  );
}

function ResearchBoardMaterial({ props }: { props: Record<string, unknown> }) {
  // surfaceInput DATA on the placeable-surface carries the connector config for the
  // Add control (gather target/definition + endpoint_template/parser/feed_address/param).
  const addConfig = (props.surfaceInput ?? {}) as AddChannelConfig;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="research board material">
        <Card variant="ghost" padding="none" layout="stack">
          <AddChannelPanel config={addConfig} />
          <ResearchBoardPanel />
        </Card>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ResearchBoardMaterial props={props} />);
}
