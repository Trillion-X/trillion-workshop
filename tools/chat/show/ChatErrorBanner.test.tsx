// PORTED FROM: bitfield-packages/packages/chat/show/ChatErrorBanner.test.tsx @ e99ac5976
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatErrorBanner, plainChatError } from './ChatErrorBanner';

afterEach(cleanup);

describe('ChatErrorBanner dispatch contract', () => {
  it('announces a plain task error and exposes retry when supplied', () => {
    const retry = vi.fn();
    render(<ChatErrorBanner error="Your message could not be sent." onDismiss={() => {}} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('Your message could not be sent.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not expose package, action, proof, hash, or execution bookkeeping', () => {
    const diagnostic = 'workflow action:owner failed with proof:abc and 1f:0123456789abcdef';
    expect(plainChatError(diagnostic)).toBe('Something went wrong. Try again.');
    render(<ChatErrorBanner error={diagnostic} onDismiss={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong. Try again.');
    expect(screen.getByRole('alert').textContent).not.toContain('proof:abc');
  });

  it.each([
    'trusted caller authority is required',
    'cryptographic attempt identity is unavailable',
    'chat-conversation-projection:conflicting-turn-replay',
    'Transcript page reply did not contain envelope payload bytes',
    'chat-conversation-owner-adapter-invalid:sequence:strictly-increasing-required',
    'compute.process returned no byte payload.',
  ])('hides an owner diagnostic: %s', (diagnostic) => {
    expect(plainChatError(diagnostic)).toBe('Something went wrong. Try again.');
  });

  it.each([
    'Your message could not be sent.',
    'Conversation list is unavailable',
    'No open workspace can show these results right now.',
  ])('preserves a plain task message: %s', (message) => {
    expect(plainChatError(message)).toBe(message);
  });
});
