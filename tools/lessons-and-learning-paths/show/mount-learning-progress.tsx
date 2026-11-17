import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../ui/show/react-surface-mount';
import { LearningProgressSurface } from './LearningProgressSurface.tsx';

type MountProps = {
  learner_id?: string;
  learnerId?: string;
  practice_action?: {
    target?: string;
    payload?: Record<string, unknown>;
    label?: string;
  };
  practiceAction?: {
    target?: string;
    payload?: Record<string, unknown>;
    label?: string;
  };
};

export function mountLearningProgress({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  const configuredAction = mountProps.practice_action ?? mountProps.practiceAction;
  const practiceAction = configuredAction?.target
    ? { ...configuredAction, target: configuredAction.target }
    : undefined;
  return mountReactMaterial(
    el,
    React.createElement(LearningProgressSurface, {
      learnerId: mountProps.learner_id ?? mountProps.learnerId,
      practiceAction,
    }),
    props,
    'Learning Progress',
  );
}

export default mountLearningProgress;
