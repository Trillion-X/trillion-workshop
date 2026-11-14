import * as React from 'react';

import { ContentStylePanel } from '@/packages/content-production/show/ContentStylePanel';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentStyleMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Style">
        <ContentStylePanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountContentStyle({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentStyleMaterial props={props} />);
}

export default mountContentStyle;
