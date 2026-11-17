import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { ConnectableServicesPanel } from './ConnectableServicesPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ConnectableServicesMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="connectable-services material">
        <ConnectableServicesPanel url={typeof props.url === 'string' ? props.url : ''} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ConnectableServicesMaterial props={props} />);
}
