import * as React from 'react';

import { RecordVideoPanel } from './RecordVideoPanel';
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

function RecordVideoMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary surfaceName="Record audio or video">
        <RecordVideoPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mountRecordVideo({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <RecordVideoMaterial props={props} />);
}

export default mountRecordVideo;
