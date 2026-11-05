// packages/group/show/ItemStylePicker.tsx
//
// The PER-ITEM appearance override popover — the cascade's third tier ("this note's own look",
// winning over the board default). It renders ITEM_APPEARANCE_CONTROLS (Note style / Text size /
// Note density) through the SAME blind BoardDefaultControl the board-default popover uses; the ONLY
// difference is the source/sink: it reads the note's own `extra` bag and writes per-item overrides
// (a "Default" pick clears the key → the note falls back to the board default, then global). Zero
// bespoke control code — the item tier is the descriptor primitive projected to a different bag.
//
// Distinct from the fill/border "Style" editor (visualLayerStack): that edits absolute fill/edge/
// opacity; this edits the appearance-CASCADE overrides (glass/card chrome, text fit, density).

import React, { useRef, useState } from 'react';
import { AnchoredOverlay, Button, Container, Icon, Text } from '../../ui/index.ts';
import { Palette, RotateCcw } from 'lucide-react';
import { BoardDefaultControl } from './BoardDefaultControl.tsx';
import { ITEM_APPEARANCE_CONTROLS, boardDefaultControlValue, type AppearanceProfile } from './item-appearance.ts';

export interface ItemStylePickerProps {
  /** The note's own appearance overrides (its `extra` bag). Per key: '' when unset → "Default" (inherit).
   *  For a MULTI-select batch pass `undefined` — every control shows "Default" and a pick applies to all. */
  itemExtra?: AppearanceProfile;
  /** Set/clear the override for a cascade key; `undefined` clears (falls back to board default).
   *  Single-item = one note's `extra`; batch = every selected note (write-only, so `itemExtra` is undefined). */
  onSet: (key: string, value: unknown) => void;
  /** Trigger button text. Default `'Note look'`. */
  label?: string;
  /** Trigger + overlay accessible name. Default `'Note look — style, text size, density'`. */
  ariaLabel?: string;
  /** The scope line inside the popover. Default `'This note'` (batch callers pass e.g. `'These 4 notes'`). */
  scopeLabel?: string;
}

export function ItemStylePicker({
  itemExtra,
  onSet,
  label = 'Note look',
  ariaLabel = 'Note look — style, text size, density',
  scopeLabel = 'This note',
}: ItemStylePickerProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // Batch callers pass itemExtra=undefined (can't know each note's state) → always offer Reset.
  // Single-item: offer it only when this note actually overrides at least one cascade key.
  const showReset =
    itemExtra === undefined ||
    ITEM_APPEARANCE_CONTROLS.some((d) => boardDefaultControlValue(itemExtra, d.key) !== '');
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Palette} size="sm" /> {label}
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} onDismiss={() => setOpen(false)}>
        <Container layout="vertical" gap="sm" padding="sm" aria-label={ariaLabel}>
          <Text variant="label">{scopeLabel}</Text>
          {ITEM_APPEARANCE_CONTROLS.map((descriptor) => (
            <BoardDefaultControl
              key={descriptor.key}
              descriptor={descriptor}
              value={boardDefaultControlValue(itemExtra, descriptor.key)}
              onSet={onSet}
            />
          ))}
          {/* Symmetric closure: clear EVERY override in one click → the note(s) inherit the
              board default again (each key set to undefined through the SAME generic onSet).
              Shown for a batch (itemExtra undefined — can't know per-note) or when this note
              actually overrides something (else it would be filler, L118). */}
          {showReset ? (
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              aria-label="Reset to board default"
              onClick={() => {
                for (const descriptor of ITEM_APPEARANCE_CONTROLS) onSet(descriptor.key, undefined);
              }}
            >
              <Icon icon={RotateCcw} size="sm" /> Reset to board default
            </Button>
          ) : null}
        </Container>
      </AnchoredOverlay>
    </>
  );
}

ItemStylePicker.displayName = 'ItemStylePicker';
