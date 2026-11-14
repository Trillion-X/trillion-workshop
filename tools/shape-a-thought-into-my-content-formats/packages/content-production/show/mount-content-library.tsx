import * as React from 'react';

import { ContentLibraryPanel } from '@/packages/content-production/show/ContentLibraryPanel';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentLibraryMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Library">
        <ContentLibraryPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountContentLibrary({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentLibraryMaterial props={props} />);
}

export default mountContentLibrary;
