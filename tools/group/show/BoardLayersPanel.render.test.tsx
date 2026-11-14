// @vitest-environment jsdom
// Render proof for the board list panel's plain-language identity (R30): the header says
// "On this board (N)", a one-line explainer says what the list IS, and the empty state
// speaks the user's words — no "Objects" jargon anywhere.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { BoardLayersPanel } from './BoardLayersPanel';
import type { BoardLayerNode } from './board-layer-rows';

afterEach(() => cleanup());

const node = (over: Partial<BoardLayerNode> = {}): BoardLayerNode => ({
  id: 'n1',
  label: 'Serve toss drill',
  kind: 'note',
  hidden: false,
  locked: false,
  selected: false,
  expanded: false,
  children: [],
  ...over,
});

const handlers = () => ({
  onSelect: vi.fn(),
  onToggleHidden: vi.fn(),
  onToggleLocked: vi.fn(),
  onRename: vi.fn(),
  onToggleExpand: vi.fn(),
  onReorder: vi.fn(),
  onClose: vi.fn(),
});

describe('BoardLayersPanel — plain-language header + explainer (R30)', () => {
  it('titles itself "On this board (N)" with the one-line explainer', () => {
    render(<BoardLayersPanel nodes={[node()]} {...handlers()} />);
    expect(screen.getByText('On this board (1)')).toBeTruthy();
    expect(screen.getByText('Every card on this board, in one list — click a name to select it.')).toBeTruthy();
    expect(screen.queryByText(/Objects/)).toBeNull();
  });

  it('empty board says so in the user words, and Close fires onClose', () => {
    const h = handlers();
    render(<BoardLayersPanel nodes={[]} {...h} />);
    expect(screen.getByText('Nothing on this board yet')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close the board list'));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a card name still selects it (rename/select wiring intact)', () => {
    const h = handlers();
    render(<BoardLayersPanel nodes={[node()]} {...h} />);
    fireEvent.click(screen.getByLabelText('Select Serve toss drill'));
    expect(h.onSelect).toHaveBeenCalledWith('n1', false);
  });
});
