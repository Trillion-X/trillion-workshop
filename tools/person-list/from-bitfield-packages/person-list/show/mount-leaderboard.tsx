// package://packages/person-list/show/mount-leaderboard.tsx

import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../../../ui';
import { LeaderboardView } from './LeaderboardView';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <LeaderboardView {...props} />, props, 'leaderboard');
}
