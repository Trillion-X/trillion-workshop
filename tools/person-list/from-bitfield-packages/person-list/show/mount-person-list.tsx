// package://packages/person-list/show/mount-person-list.tsx

import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../../../ui';
import { PersonDirectory } from './PersonDirectory';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <PersonDirectory />, props, 'person list');
}
