import React from 'react';
import { mountReactSurface } from '../../ui';
import { ScreenLookSurface } from './ScreenLookSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, React.createElement(ScreenLookSurface, props));
}
