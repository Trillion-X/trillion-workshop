// @vitest-environment jsdom
// Render proof for the comments triage panel's ACTIONABLE empty state (R23): a first-time
// user with zero comments sees the exact how-to steps, with the button name matching the
// selection toolbar's real "Comment" button (SelectedItemToolbar).
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { CommentsReviewPanel } from './CommentsReviewPanel';

afterEach(() => cleanup());

describe('CommentsReviewPanel — empty state teaches the real flow (R23)', () => {
  it('with no threads, renders the how-to steps naming the toolbar Comment button', () => {
    render(<CommentsReviewPanel rows={[]} onJumpTo={() => {}} onClose={() => {}} />);
    expect(screen.getByText('No comments yet. To start one:')).toBeTruthy();
    expect(screen.getByText('1. Click a card on the board')).toBeTruthy();
    expect(screen.getByText('2. Press the Comment button that appears in the toolbar')).toBeTruthy();
  });
});
