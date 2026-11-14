// @vitest-environment jsdom
// Render proof for the vote chip's self-describing copy (R24): the tally reads as VOTES
// (thumb icon + count with an explaining title/aria-label), and the +/- controls say what
// they do in plain words — never a bare unexplained pill.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { BoardVotesLayer, type VoteChip } from './BoardVotesLayer';

afterEach(() => cleanup());

const chip = (over: Partial<VoteChip> = {}): VoteChip => ({
  memberId: 'm1',
  rect: { x: 10, y: 10, w: 100, h: 60 },
  count: 3,
  mine: 1,
  ...over,
});

describe('BoardVotesLayer — the chip explains itself (R24)', () => {
  it('in voting mode the tally is labeled "N votes — press + to add yours" and +/- say what they do', () => {
    const onVote = vi.fn();
    render(<BoardVotesLayer chips={[chip()]} voting budgetRemaining={4} onVote={onVote} />);
    expect(screen.getByLabelText('3 votes — press + to add yours')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Add my vote'));
    expect(onVote).toHaveBeenCalledWith('m1', 1);
    fireEvent.click(screen.getByLabelText('Take my vote back'));
    expect(onVote).toHaveBeenCalledWith('m1', -1);
  });

  it('outside voting mode a voted item shows a plain "N votes" read-only tally', () => {
    render(<BoardVotesLayer chips={[chip()]} voting={false} budgetRemaining={0} onVote={() => {}} />);
    expect(screen.getByLabelText('3 votes')).toBeTruthy();
    expect(screen.queryByLabelText('Add my vote')).toBeNull();
    expect(screen.queryByLabelText('Take my vote back')).toBeNull();
  });

  it('outside voting mode an unvoted item renders nothing (no clutter)', () => {
    const { container } = render(
      <BoardVotesLayer chips={[chip({ count: 0, mine: 0 })]} voting={false} budgetRemaining={5} onVote={() => {}} />,
    );
    expect(container.textContent).toBe('');
  });

  it('the + disables when the budget is spent; the - disables when I have no vote here', () => {
    render(
      <BoardVotesLayer chips={[chip({ mine: 0 })]} voting budgetRemaining={0} onVote={() => {}} />,
    );
    expect((screen.getByLabelText('Add my vote') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Take my vote back') as HTMLButtonElement).disabled).toBe(true);
  });
});
