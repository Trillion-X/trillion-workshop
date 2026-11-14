import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { readSelectedFilePath } from '../read-data/read-selected-file-path.ts';
import { FileEditor } from './FileEditor.tsx';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readInitialFilePath(props: Record<string, unknown>): string | null {
  const direct = typeof props.filePath === 'string' && props.filePath.length > 0 ? props.filePath : null;
  if (direct) return direct;

  const inputPath = readStringField(props.surfaceInput, 'filePath') ?? readStringField(props.surfaceInput, 'path');
  return inputPath;
}

function MountedFileEditor({ props }: { props: Record<string, unknown> }) {
  const selectedFileEntry = useBitfieldData('selected-file');
  const selectedFilePath = readSelectedFilePath(selectedFileEntry);
  const explicitFilePath = readInitialFilePath(props);
  const [pinnedFilePath, setPinnedFilePath] = React.useState<string | null>(explicitFilePath);
  const [followsSelection, setFollowsSelection] = React.useState(false);

  React.useEffect(() => {
    if (explicitFilePath) setPinnedFilePath(explicitFilePath);
  }, [explicitFilePath]);

  React.useEffect(() => {
    if (!selectedFilePath || explicitFilePath) return;
    if (!pinnedFilePath || followsSelection) {
      setPinnedFilePath(selectedFilePath);
      setFollowsSelection(false);
    }
  }, [explicitFilePath, followsSelection, pinnedFilePath, selectedFilePath]);

  const filePath = explicitFilePath ?? pinnedFilePath ?? selectedFilePath;
  const sourceLabel = explicitFilePath
    ? 'Opened directly'
    : pinnedFilePath
      ? 'Locked to this file'
      : selectedFilePath
        ? 'Following'
        : undefined;

  // A code editor must OWN its scroll: CodeMirror's scroll-to-match only moves
  // its own `.cm-scroller`, which scrolls only when the editor is height-bounded.
  // FloatingMaterialFrame's default "inline" mode is unbounded (parent scroll
  // lanes own overflow), so search navigation could never scroll the viewport.
  // Force "fill" mode (bounded, overflow:hidden) so `.cm-scroller` is the
  // scroller; keep any other caller-supplied frame fields.
  const baseFrame =
    props.floating_frame && typeof props.floating_frame === 'object' && !Array.isArray(props.floating_frame)
      ? (props.floating_frame as Record<string, unknown>)
      : {};
  const editorFrame = { ...baseFrame, mode: 'fill' };

  return React.createElement(
    FloatingMaterialFrame,
    { frame: editorFrame },
    React.createElement(FileEditor, {
      filePath: filePath ?? undefined,
      sourceLabel,
      onFollowSelection: explicitFilePath
        ? undefined
        : () => {
            if (selectedFilePath) setPinnedFilePath(selectedFilePath);
            setFollowsSelection(true);
          },
    }),
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, React.createElement(MountedFileEditor, { props }));
}
