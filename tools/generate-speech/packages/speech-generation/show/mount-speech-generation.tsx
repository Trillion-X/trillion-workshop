import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { SpeechGenerationPanel } from '@/packages/speech-generation/show/SpeechGenerationPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function SpeechGenerationMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Make voice audio">
        <SpeechGenerationPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <SpeechGenerationMaterial props={props} />);
}
