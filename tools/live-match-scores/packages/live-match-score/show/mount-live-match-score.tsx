import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui/show/react-surface-mount';
import { LiveMatchScoreSurface } from '@/packages/live-match-score/show/LiveMatchScoreSurface';

type MountProps = {
  user_id?: string;
  userId?: string;
};

export function mountLiveMatchScore({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(LiveMatchScoreSurface, {
      userId: mountProps.user_id ?? mountProps.userId,
    }),
    props,
    'Live Score',
  );
}

export default mountLiveMatchScore;
