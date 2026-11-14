// PORTED FROM: bitfield-packages/packages/chat/show/AgentActivityRenderer.private-content.test.tsx @ e99ac5976
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentActivityRenderer } from './AgentActivityRenderer';

afterEach(cleanup);

function message(type: string, content: string) {
  return {
    id: `${type}-message`,
    type,
    role: 'assistant',
    content,
    timestamp: '2026-09-11T00:00:00.000Z',
  } as any;
}

describe('AgentActivityRenderer private content boundary', () => {
  it('does not render agent thoughts', () => {
    const { container } = render(
      <AgentActivityRenderer message={message('thinking', 'I should inspect the hidden account reference next.')} />,
    );
    expect(container.textContent).toBe('');
  });

  it('does not render context-management summaries', () => {
    const { container } = render(
      <AgentActivityRenderer
        message={message(
          'text',
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation. Internal owner notes follow.',
        )}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('does not render teammate IDs or private teammate summaries', () => {
    const privateMessage = {
      ...message('text', 'The document is ready.'),
      teammate: { id: 'agent:private-worker-7', summary: 'hidden chain-of-thought summary' },
    };
    render(<AgentActivityRenderer message={privateMessage} />);
    expect(screen.getByText('The document is ready.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-worker');
    expect(document.body.textContent).not.toContain('chain-of-thought');
  });

  it('reduces diagnostic errors and internal status values to plain task language', () => {
    const rendered = render(
      <AgentActivityRenderer message={message('error', 'chat-conversation-owner-adapter-invalid:sequence:strictly-increasing-required')} />,
    );
    expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('adapter');

    rendered.rerender(
      <AgentActivityRenderer message={message('status', 'workflow:dispatching-owner-ref-1f:0123456789abcdef')} />,
    );
    expect(screen.getByText('Your assistant is working')).toBeTruthy();
    expect(document.body.textContent).not.toContain('workflow');
  });
});
