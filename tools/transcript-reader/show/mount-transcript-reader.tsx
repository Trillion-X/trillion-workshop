import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import {
  TranscriptReaderSurface,
  type TranscriptReaderSurfaceProps,
} from './TranscriptReaderSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TranscriptReaderMaterial({ props }: { props: Record<string, unknown> }) {
  const readerProps = props as unknown as Partial<TranscriptReaderSurfaceProps>;
  const segments = Array.isArray(readerProps.segments) ? readerProps.segments : [];
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Transcript">
        <TranscriptReaderSurface {...readerProps} segments={segments} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TranscriptReaderMaterial props={props} />);
}

