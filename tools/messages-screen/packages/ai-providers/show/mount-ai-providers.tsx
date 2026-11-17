import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { AiProvidersSurface } from './AiProvidersSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function AiProvidersMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ai-providers material">
        <AiProvidersSurface />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AiProvidersMaterial props={props} />);
}
