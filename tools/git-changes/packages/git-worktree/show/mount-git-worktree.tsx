import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { GitChangesPanel } from '@/packages/git-worktree/show/GitChangesPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function GitWorktreeMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="git-worktree material">
        <GitChangesPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <GitWorktreeMaterial props={props} />);
}
