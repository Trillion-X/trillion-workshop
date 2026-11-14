// PORTED FROM: bitfield-packages/packages/chat/show/__tests__/chat-connect-ai-callout.test.tsx @ e99ac5976
// packages/chat/show/__tests__/chat-connect-ai-callout.test.tsx
//
// Proves the discoverable "Connect your AI" affordance (Task #79):
//   - `prominent` shows the connect title + subtitle + a Connect action.
//   - `quiet` shows a low-key participant chooser for the established catalog.
//   - both fire onConnect (the entry into ParticipantBrowser).
//   - no provider/model vocabulary leaks into the copy (L090/L114).

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatConnectAiCallout } from '../ChatConnectAiCallout';

describe('ChatConnectAiCallout', () => {
  it('prominent: shows the connect title and subtitle and fires onConnect', () => {
    const onConnect = vi.fn();
    render(<ChatConnectAiCallout intent="prominent" onConnect={onConnect} />);
    // getByText throws if the node is absent, so a truthy assertion is sufficient
    // without the jest-dom matcher set (not configured in this package's vitest).
    expect(screen.getByText('Connect your AI')).toBeTruthy();
    expect(screen.getByText(/Bring your CLI/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Connect your AI/i }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('quiet: shows a low-key participant chooser and fires onConnect', () => {
    const onConnect = vi.fn();
    render(<ChatConnectAiCallout intent="quiet" onConnect={onConnect} />);
    const control = screen.getByRole('button', { name: /Choose participants/i });
    fireEvent.click(control);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('copy names no provider, model, or vendor (blind, L090)', () => {
    const { container } = render(<ChatConnectAiCallout intent="prominent" onConnect={() => {}} />);
    const text = container.textContent ?? '';
    for (const banned of ['OpenAI', 'Anthropic', 'Claude', 'GPT', 'Gemini', 'cli_registry', 'participant']) {
      expect(text).not.toContain(banned);
    }
  });
});
