import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../../../ui';
import { AIGuidedWork } from './AIGuidedWork';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <AIGuidedWork />, props, 'ai-guided-work material');
}
