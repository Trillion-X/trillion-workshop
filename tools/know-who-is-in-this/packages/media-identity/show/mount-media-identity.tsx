import React from 'react';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { MediaIdentityPanel } from './MediaIdentityPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function MediaIdentityMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Find people and voices">
        <MediaIdentityPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MediaIdentityMaterial props={props} />);
}
