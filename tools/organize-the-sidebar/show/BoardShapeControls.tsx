// packages/group/show/BoardShapeControls.tsx
//
// The item SHAPE control (FigJam/Miro shape picker): when ≥1 board item is selected,
// this appears in the board's selection bar and reshapes the selection in one click.
// It writes the chosen shape id to `extra.shape` (via `onPick`); the blind
// `CanvasNode` resolves it to a `clip-path` and clips the item's content into the
// geometry. The catalog (`BOARD_SHAPES`) is feature DATA — adding a shape is one row,
// zero code here (L090). Built only from shipped `ui` primitives (Button/Icon/
// Container/AnchoredOverlay/Text/Tooltip) — zero raw HTML (L065).

import React, { useRef, useState } from 'react';
import { Button, Container, Text, Tooltip, AnchoredOverlay } from '../../ui';
import { NamedIcon } from '../../ui/show/icon/NamedIcon';
import { BOARD_SHAPES } from './board-shapes';

export interface BoardShapeControlsProps {
  /** The anchor item's current shape id (undefined / 'rectangle' = no shape). */
  shape?: string | undefined;
  /** Set the selection's shape (a catalog id; 'rectangle' clears the clip). */
  onPick: (shapeId: string) => void;
}

/** Shape picker for the selected board item(s). */
export function BoardShapeControls({ shape, onPick }: BoardShapeControlsProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const activeId = shape && shape.length > 0 ? shape : 'rectangle';
  const activeIcon = BOARD_SHAPES.find((s) => s.id === activeId)?.icon ?? 'Square';
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <Tooltip label="Shape">
        <Button ref={anchor} variant="ghost" size="icon" aria-label="Shape" onClick={() => setOpen((o) => !o)}>
          <NamedIcon name={activeIcon} />
        </Button>
      </Tooltip>
      <AnchoredOverlay anchorRef={anchor} open={open} onDismiss={() => setOpen(false)}>
        <Container layout="vertical" gap="sm" padding="sm" aria-label="Shape picker">
          <Text variant="label">Shape</Text>
          <Container layout="grid" gridCols={3} gap="xs">
            {BOARD_SHAPES.map((s) => (
              <Button
                key={s.id}
                variant={s.id === activeId ? 'primary' : 'ghost'}
                size="icon"
                aria-label={s.label}
                aria-pressed={s.id === activeId}
                onClick={() => { onPick(s.id); setOpen(false); }}
              >
                <NamedIcon name={s.icon} />
              </Button>
            ))}
          </Container>
        </Container>
      </AnchoredOverlay>
    </Container>
  );
}
