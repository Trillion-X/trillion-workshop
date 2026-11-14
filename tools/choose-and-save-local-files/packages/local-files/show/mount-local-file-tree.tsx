import React from 'react';
import { FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import {
  sendLocalFileSelection,
  type LocalFileSelectionTarget,
} from '@/packages/local-files/do-work/send-local-file-selection';
import { FileTree } from './LocalFileTree';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readSelectionTarget(value: unknown): LocalFileSelectionTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.target !== 'string') return null;
  if (typeof row.definition_id !== 'string') return null;
  return {
    target: row.target,
    definition_id: row.definition_id,
    input_field: typeof row.input_field === 'string' ? row.input_field : undefined,
  };
}

const DEFAULT_FILES_SELECTION_TARGET: LocalFileSelectionTarget = {
  target: 'slot::workflow',
  definition_id: 'action:update-files-selected-file',
  input_field: 'path',
};

export default function mount({ el, props = {} }: MountArgs) {
  const selectionTarget = readSelectionTarget(props.selection_target) ?? DEFAULT_FILES_SELECTION_TARGET;
  return mountReactSurface(
    el,
    React.createElement(
      FloatingMaterialFrame,
      { frame: props.floating_frame },
      React.createElement(FileTree, {
        onFileSelect: (path: string) => {
          void sendLocalFileSelection(selectionTarget, path);
        },
      }),
    ),
  );
}
