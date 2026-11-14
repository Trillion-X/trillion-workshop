// Self-contained, read-only entry used by Visual Database selection projections.
// It deliberately has no live package reads: the projection supplies all data.
import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import {
  invokeVisualDatabaseAction,
  type VisualDatabaseTargetSender,
} from '@/packages/visual-database/do-work/visual-database-actions';
import { decodeVisualDatabaseEvaluatorDescriptors, decodeVisualDatabaseModel } from '@/packages/visual-database/read-data/visual-database';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function selectedInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function SelectedVisualDatabase({ props }: { props: Record<string, unknown> }) {
  const input = selectedInput(props.surfaceInput);
  const actionSender = typeof props.actionSender === 'function'
    ? props.actionSender as VisualDatabaseTargetSender
    : undefined;
  const model = decodeVisualDatabaseModel({
    records: input.records,
    fields: input.fields,
    views: input.views,
    actions: input.actions,
    gridProperties: input.gridProperties,
  });
  return <FloatingMaterialFrame frame={props.floating_frame}>
    <ErrorBoundary zoneName="selected visual database material">
      <VisualDatabaseSurface
        model={model}
        evaluatorDescriptors={decodeVisualDatabaseEvaluatorDescriptors(input.evaluatorDescriptors)}
        onInvokeAction={(action, context) => invokeVisualDatabaseAction(action, context, actionSender)}
      />
    </ErrorBoundary>
  </FloatingMaterialFrame>;
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <SelectedVisualDatabase props={props} />);
}
