import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { TranscriptHistoryPanel } from '@/packages/transcript-history/show/TranscriptHistoryPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TranscriptHistoryMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Past transcripts">
        <TranscriptHistoryPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TranscriptHistoryMaterial props={props} />);
}
