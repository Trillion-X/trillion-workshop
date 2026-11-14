import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { PublicDocumentSite } from '@/packages/public-document-site/show/PublicDocumentSite';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function PublicDocumentSiteMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Documents">
        <PublicDocumentSite />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PublicDocumentSiteMaterial props={props} />);
}
