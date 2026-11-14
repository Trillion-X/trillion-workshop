// packages/learning-path/show/mount-learning-path.tsx
// Mounts the learning-path surface: reads the journey feed (surface-state),
// builds the screen model, renders the winding path.

import React from 'react';
import { emitPlaceableSurfaceIntent, ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/learning-path/.bitfield-entry-scope/learning-path/runtime-kit-react';
import { sendRequestToBitfieldTarget } from '@/packages/learning-path/.bitfield-entry-scope/learning-path/runtime-kit';
import { buildLearningPathSurfaceModelFromSources, LearningPathSurface } from './LearningPathSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function LearningPathMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceState = useBitfieldData<unknown>('surface-state');
  const surfaceInput = isRecord(props.surface_input) ? props.surface_input : {};
  const progressViewAddress = nonEmpty(surfaceInput.progress_view_address_label);
  const progressViews = useBitfieldData<unknown>({
    input: 'progress-view-by-address-label',
    params: { addressLabel: progressViewAddress },
  });
  const model = buildLearningPathSurfaceModelFromSources({
    surfaceState,
    progressViews: Array.isArray(progressViews) ? progressViews : undefined,
  });
  // Tapping an enabled level dispatches that node's self-describing action
  // (target + payload carried as feed data). The mount names no specific target
  // or level; a node with no action is a no-op. This is what makes the coins
  // clickable end to end.
  const onActivate = React.useCallback((id: string) => {
    const node = model.nodes.find((candidate) => candidate.id === id);
    const action = node?.action as
      | { target?: string; payload?: Record<string, unknown>; surface?: Record<string, unknown> }
      | undefined;
    if (!action) return;
    // Field-presence gate (no kind switch): a `surface` field opens that
    // placeable surface as a tab via the shared intent; a `target` field
    // dispatches a request. Both are opaque DATA from the feed.
    if (action.surface) {
      emitPlaceableSurfaceIntent(action.surface as never);
      return;
    }
    if (action.target) {
      void sendRequestToBitfieldTarget({ target: action.target, payload: action.payload ?? {} });
    }
  }, [model]);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="learning path material">
        <LearningPathSurface model={model} onActivate={onActivate} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <LearningPathMaterial props={props} />);
}
