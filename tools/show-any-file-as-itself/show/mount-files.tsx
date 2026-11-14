import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../ui/index.ts';
import { FilesWorkspace } from './FilesWorkspace.tsx';

function readSurfaceInput(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = props.surfaceInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(
    el,
    <FilesWorkspace surfaceInput={readSurfaceInput(props)} />,
    props,
    'files material',
  );
}
