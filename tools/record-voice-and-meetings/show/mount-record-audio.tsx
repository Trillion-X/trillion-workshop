import * as React from 'react';

import { RecordAudioPanel } from './RecordAudioPanel';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { registerLocalActorAdmission } from '../../ui/show/action-affordance';

// This surface runs in the local desktop app: its admitted bytes register the
// local-actor admission carrier so owner-save dispatches (recorded media)
// arrive already admitted. Hosted publications never include this module.
registerLocalActorAdmission();

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function RecordAudioMaterial({ props }: { props: Record<string, unknown> }) {
  const input = props.surfaceInput && typeof props.surfaceInput === 'object'
    ? props.surfaceInput as Record<string, unknown> : {};
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary surfaceName="Record audio or video">
        <RecordAudioPanel completionTarget={input.completion_target} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountRecordAudio({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <RecordAudioMaterial props={props} />);
}

export default mountRecordAudio;
