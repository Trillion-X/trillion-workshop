import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { CaptionRendererPanel } from '@/packages/caption-renderer/show/CaptionRendererPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function CaptionRendererMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Make captions">
        <CaptionRendererPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CaptionRendererMaterial props={props} />);
}
