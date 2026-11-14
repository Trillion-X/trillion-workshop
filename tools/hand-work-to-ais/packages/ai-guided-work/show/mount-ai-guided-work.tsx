import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui';
import { AIGuidedWork } from '@/packages/ai-guided-work/show/AIGuidedWork';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <AIGuidedWork />, props, 'ai-guided-work material');
}
