import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { CapabilityGate } from './CapabilityGate.tsx';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function CapabilityGateMaterial({ props }: { props: Record<string, unknown> }) {
  // The gate descriptor arrives as the surface's own input; CapabilityGate also
  // falls back to a published `capability-gate` record.
  const descriptorSource = (props.surface_input as unknown) ?? props;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="capability-gate material">
        <CapabilityGate descriptorSource={descriptorSource} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CapabilityGateMaterial props={props} />);
}
