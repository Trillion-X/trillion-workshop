// @vitest-environment jsdom
// Render proof for the generic RankedJumpList: rows render with label + badge + note, a row click fires
// onJumpTo(id) with the jumpVerb-formatted aria-label, empty state shows emptyText, Close fires onClose.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { RankedJumpList, type RankedRow } from './RankedJumpList';

afterEach(() => cleanup());

const rows: RankedRow[] = [
  { id: 'a', label: 'Ship faster', badge: '3', note: 'me: do it' },
  { id: 'b', label: 'Lower price', badge: '1' },
];

describe('RankedJumpList — the generic list primitive', () => {
  it('renders each row (label + badge + note) and jumps on click with the verb-formatted label', () => {
    const onJumpTo = vi.fn();
    render(<RankedJumpList title="Top voted" subtitle="4 votes" rows={rows} emptyText="none" jumpVerb="the idea" onJumpTo={onJumpTo} onClose={() => {}} />);
    expect(screen.getByText('Ship faster')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('me: do it')).toBeTruthy();
    expect(screen.getByText('4 votes')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Jump to the idea Ship faster'));
    expect(onJumpTo).toHaveBeenCalledWith('a');
  });

  it('with no jumpVerb the aria-label is just "Jump to <label>"', () => {
    const onJumpTo = vi.fn();
    render(<RankedJumpList title="X" rows={rows} emptyText="none" onJumpTo={onJumpTo} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Jump to Lower price'));
    expect(onJumpTo).toHaveBeenCalledWith('b');
  });

  it('shows emptyText when there are no rows, and Close fires onClose', () => {
    const onClose = vi.fn();
    render(<RankedJumpList title="Comments" rows={[]} emptyText="Nothing here yet" onJumpTo={() => {}} onClose={onClose} />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close Comments panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders emptySteps as numbered how-to rows under the empty text (R23)', () => {
    render(
      <RankedJumpList
        title="Comments"
        rows={[]}
        emptyText="No comments yet. To start one:"
        emptySteps={['Click a card on the board', 'Press the Comment button that appears in the toolbar']}
        onJumpTo={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('No comments yet. To start one:')).toBeTruthy();
    expect(screen.getByText('1. Click a card on the board')).toBeTruthy();
    expect(screen.getByText('2. Press the Comment button that appears in the toolbar')).toBeTruthy();
  });

  it('with rows present, emptySteps render nothing (steps belong to the empty state only)', () => {
    render(
      <RankedJumpList
        title="Comments"
        rows={rows}
        emptyText="none"
        emptySteps={['Click a card on the board']}
        onJumpTo={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('1. Click a card on the board')).toBeNull();
  });
});
