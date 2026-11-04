// packages/group/show/BulkBarPickerRows.tsx
// The BulkSelectBar's inline picker rows: saved style presets and frame aspects.

import React from 'react';
import { Button, Container, Text } from '../../ui';
import type { SavedBundle } from '../do-work/attribute-bundle-palette';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack/visual-layer-types';
import { FRAME_ASPECTS, type FrameAspect } from './frame-aspects';

export interface SavedPresetsRowProps {
  presets: readonly SavedBundle<VisualLayerStackRecord>[];
  onApply: (bundle: VisualLayerStackRecord) => void;
}

export function SavedPresetsRow({ presets, onApply }: SavedPresetsRowProps) {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" wrap>
      {presets.length === 0 ? (
        <Text variant="body-xs" color="muted">No presets yet</Text>
      ) : (
        presets.map((p) => (
          <Button key={p.id} variant="secondary" size="sm" onClick={() => onApply(p.bundle)}>
            {p.name}
          </Button>
        ))
      )}
    </Container>
  );
}

export interface FrameAspectRowProps {
  onPick: (aspect: FrameAspect) => void;
}

/** #177 — a blind row of the FRAME_ASPECTS DATA labels. Picking one reshapes
 *  every selected frame; adding a preset is one catalog row. */
export function FrameAspectRow({ onPick }: FrameAspectRowProps) {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" wrap>
      {FRAME_ASPECTS.map((a) => (
        <Button key={a.id} variant="secondary" size="sm" onClick={() => onPick(a)}>
          {a.label}
        </Button>
      ))}
    </Container>
  );
}
