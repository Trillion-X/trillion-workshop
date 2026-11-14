import * as React from 'react';

import { ContentDeliverablesPanel } from '@/packages/content-production/show/ContentDeliverablesPanel';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentDeliverablesMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Deliverables">
        <ContentDeliverablesPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountContentDeliverables({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentDeliverablesMaterial props={props} />);
}

export default mountContentDeliverables;
