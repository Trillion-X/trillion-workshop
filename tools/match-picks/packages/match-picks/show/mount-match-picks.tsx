import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../../../ui/show/react-surface-mount';
import { MatchPicksSurface } from './MatchPicksSurface';

type MountProps = {
  picker_id?: string;
  pickerId?: string;
};

export function mountMatchPicks({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(MatchPicksSurface, {
      pickerId: mountProps.picker_id ?? mountProps.pickerId,
    }),
    props,
    'Match Picks',
  );
}

export default mountMatchPicks;
