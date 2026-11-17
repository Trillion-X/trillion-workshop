import * as React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { AvailabilitySetupForm } from './AvailabilitySetupForm';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function CalendarAvailabilitySetupMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = (
    (props.surface_input && typeof props.surface_input === 'object' && !Array.isArray(props.surface_input))
      ? props.surface_input
      : (props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput))
        ? props.surfaceInput
        : props
  ) as Record<string, unknown>;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="calendar availability setup material">
        <AvailabilitySetupForm surfaceInput={surfaceInput} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CalendarAvailabilitySetupMaterial props={props} />);
}
