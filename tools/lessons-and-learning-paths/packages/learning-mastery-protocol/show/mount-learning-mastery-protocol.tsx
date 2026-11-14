import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { LearningMasteryProtocolPanel } from '@/packages/learning-mastery-protocol/show/LearningMasteryProtocolPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function LearningMasteryMaterial({ props }: { props: Record<string, unknown> }) {
  // PlaceableSurfaceHost delivers the surface config as `props.surfaceInput`
  // (camelCase, nested). Accept both spellings so the surface_input carries
  // through regardless of host casing (same bridge as mount-file-content-surface).
  const input = isRecord(props.surfaceInput)
    ? props.surfaceInput
    : isRecord(props.surface_input)
      ? props.surface_input
      : {};
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="learning mastery protocol material">
        <LearningMasteryProtocolPanel
          descriptorAddressLabel={text(input.protocol_descriptor_address_label)}
          stateAddressLabel={text(input.protocol_state_address_label)}
          acceptedDecisionAddressLabel={text(input.accepted_decision_address_label)}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <LearningMasteryMaterial props={props} />);
}
