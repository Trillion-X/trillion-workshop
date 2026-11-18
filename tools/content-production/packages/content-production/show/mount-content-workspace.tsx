import * as React from 'react';

import { ContentWorkspaceShell } from '../../../../shape-a-thought-into-my-content-formats/packages/content-production/show/ContentWorkspaceShell';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentWorkspaceMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Content workspace">
        <ContentWorkspaceShell />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountContentWorkspace({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentWorkspaceMaterial props={props} />);
}

export default mountContentWorkspace;
