import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { EventGroupPanel } from './EventGroupPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function EventGroupMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="event-group material">
        <EventGroupPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <EventGroupMaterial props={props} />);
}
