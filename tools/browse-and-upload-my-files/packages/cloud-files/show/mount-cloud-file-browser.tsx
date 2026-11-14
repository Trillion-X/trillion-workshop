import React from 'react';
import { FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { CloudFileBrowser } from '@/packages/cloud-files/show/CloudFileBrowser';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(
    el,
    React.createElement(
      FloatingMaterialFrame,
      { frame: props.floating_frame },
      React.createElement(CloudFileBrowser),
    ),
  );
}
