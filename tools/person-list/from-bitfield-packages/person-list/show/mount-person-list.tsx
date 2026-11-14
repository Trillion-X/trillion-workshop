// package://packages/person-list/show/mount-person-list.tsx

import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui';
import { PersonDirectory } from './PersonDirectory';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <PersonDirectory />, props, 'person list');
}
