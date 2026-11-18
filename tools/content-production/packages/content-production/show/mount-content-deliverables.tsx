import * as React from 'react';

import { ContentDeliverablesPanel } from '../../../../shape-a-thought-into-my-content-formats/packages/content-production/show/ContentDeliverablesPanel';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';

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
