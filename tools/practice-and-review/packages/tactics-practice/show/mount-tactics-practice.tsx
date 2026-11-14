import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { TacticsPracticeSurface } from '@/packages/tactics-practice/show/TacticsPracticeSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TacticsPracticeMaterial({ props }: { props: Record<string, unknown> }) {
  const userId = typeof props.user_id === 'string'
    ? props.user_id
    : typeof props.userId === 'string'
      ? props.userId
      : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Tactics Tactics">
        <TacticsPracticeSurface userId={userId} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TacticsPracticeMaterial props={props} />);
}
