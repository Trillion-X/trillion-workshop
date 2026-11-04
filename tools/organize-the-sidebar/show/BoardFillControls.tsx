// packages/group/show/BoardFillControls.tsx
//
// The item fill-color control (FigJam/Miro/Milanote sticky-color canon): when ≥1
// board item is selected, this appears in the board's selection bar and recolors
// the selection in one click. It writes the SAME `visualLayerStack` solid fill the
// Style editor edits (via `onPick`) — a fast path to one source of truth, never a
// parallel color field. Built only from shipped `ui` molecules (ColorDot +
// ColorPickerPopover + Button + Tooltip) — zero new primitive, zero raw HTML (L065).

import React, { useRef, useState } from 'react';
import { Button, ColorDot, ColorPickerPopover, Tooltip, Container } from '../../ui';
import { NamedIcon } from '../../ui/show/icon/NamedIcon';
import { BOARD_FILL_SWATCHES } from './item-fill';

const DEFAULT_COLOR = '#fde68a';
/** The quick swatch hexes (the wheel still gives full freedom); None is its own button. */
const PRESETS = BOARD_FILL_SWATCHES.map((s) => s.color).filter((c): c is string => c !== null);

export interface BoardFillControlsProps {
  /** The anchor item's current fill color (undefined = no fill). */
  color?: string | undefined;
  /** Set the selection's fill (a hex) or clear it (null). `undoable:false` = live
   *  preview while dragging the wheel; the final value lands as one undoable step. */
  onPick: (color: string | null, opts?: { undoable?: boolean }) => void;
}

/** Fill-color picker for the selected board item(s). */
export function BoardFillControls({ color, onPick }: BoardFillControlsProps) {
  const colorAnchor = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = color || DEFAULT_COLOR;
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <Tooltip label="Fill color">
        <Button
          ref={colorAnchor}
          variant="ghost"
          size="icon"
          aria-label="Fill color"
          onClick={() => setPickerOpen((o) => !o)}
        >
          <ColorDot color={color || 'transparent'} size="md" />
        </Button>
      </Tooltip>
      <ColorPickerPopover
        anchorRef={colorAnchor}
        open={pickerOpen}
        value={current}
        presets={PRESETS}
        title="Fill color"
        onChange={(hex) => onPick(hex, { undoable: false })}
        onSave={(hex) => { onPick(hex); setPickerOpen(false); }}
        saveLabel="Done"
        onDismiss={() => setPickerOpen(false)}
      />
      {color ? (
        <Tooltip label="No fill">
          <Button variant="ghost" size="icon" aria-label="No fill" onClick={() => onPick(null)}>
            <NamedIcon name="Ban" />
          </Button>
        </Tooltip>
      ) : null}
    </Container>
  );
}
