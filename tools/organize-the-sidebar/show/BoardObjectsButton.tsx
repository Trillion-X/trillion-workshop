// packages/group/show/BoardObjectsButton.tsx
// The header "On this board" button + its anchored popover wrapping BoardLayersPanel (#151).
// Renamed from "Objects" (R30) — the panel is the board's card list, said in the user's words.

import React, { useRef } from 'react';
import { AnchoredOverlay, Button, Icon } from '../../ui/index.ts';
import { Layers } from 'lucide-react';
import { BoardLayersPanel, type BoardLayersPanelProps } from './BoardLayersPanel.tsx';

export interface BoardObjectsButtonProps extends Omit<BoardLayersPanelProps, 'onClose'> {
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
}

export function BoardObjectsButton({ open, onToggleOpen, onClose, ...panelProps }: BoardObjectsButtonProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        aria-label="On this board — every card, one list"
        title="On this board — every card, one list"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        {/* R50a: a VISIBLE label like every other header button (Export/Look/Guide) —
            an icon-only trigger left users guessing what "the layers thing" was. */}
        <Icon icon={Layers} size="sm" /> On board
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} onDismiss={onClose}>
        <BoardLayersPanel {...panelProps} onClose={onClose} />
      </AnchoredOverlay>
    </>
  );
}
