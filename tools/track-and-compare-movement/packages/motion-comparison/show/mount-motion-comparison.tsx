import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../../../ui/show/react-surface-mount';
import { MotionComparisonSurface } from './MotionComparisonSurface';

type MountProps = {
  user_id?: string;
  userId?: string;
};

export function mountMotionComparison({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(MotionComparisonSurface, {
      userId: mountProps.user_id ?? mountProps.userId,
    }),
    props,
    'Motion Compare',
  );
}

export default mountMotionComparison;
