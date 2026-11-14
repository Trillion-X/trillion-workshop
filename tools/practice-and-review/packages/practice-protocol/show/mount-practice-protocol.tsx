import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui/show/react-surface-mount';
import { PracticeProtocolSurface } from '@/packages/practice-protocol/show/PracticeProtocolSurface';

type MountProps = {
  learner_id?: string;
  learnerId?: string;
  event_target?: string;
  eventTarget?: string;
};

export function mountPracticeProtocol({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(PracticeProtocolSurface, {
      learnerId: mountProps.learner_id ?? mountProps.learnerId,
      eventTarget: mountProps.event_target ?? mountProps.eventTarget,
    }),
    props,
    'Practice Protocol',
  );
}

export default mountPracticeProtocol;
