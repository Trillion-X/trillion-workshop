import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui/show/react-surface-mount';
import { SpacedRepetitionSurface } from '@/packages/spaced-repetition/show/SpacedRepetitionSurface';

type MountProps = {
  learner_id?: string;
  learnerId?: string;
  response_target?: string;
  responseTarget?: string;
};

export function mountSpacedRepetition({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(SpacedRepetitionSurface, {
      learnerId: mountProps.learner_id ?? mountProps.learnerId,
      responseTarget: mountProps.response_target ?? mountProps.responseTarget,
    }),
    props,
    'Spaced Repetition',
  );
}

export default mountSpacedRepetition;
