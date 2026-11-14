// PORTED FROM: bitfield-packages/packages/chat/show/__tests__/chat-filter-popover-profile-labels.test.tsx @ e99ac5976
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatFilterPopover } from '../ChatFilterPopover';

afterEach(cleanup);

describe('ChatFilterPopover profile labels', () => {
  it('renders profile labels while keeping internal refs as selection keys', () => {
    const onSelectionChange = vi.fn();
    render(
      <ChatFilterPopover
        availableParticipants={[
          { participantRef: 'ai-agent-profile:coder', label: 'Coder' },
          { participantRef: 'ai-agent-profile:writer', label: 'Writer' },
        ]}
        selectedParticipants={new Set()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter by participant' }));
    expect(screen.getByRole('option', { name: 'Coder' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Writer' })).toBeTruthy();
    expect(screen.queryByText('ai-agent-profile:coder')).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: 'Coder' }));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['ai-agent-profile:coder']));
  });
});
