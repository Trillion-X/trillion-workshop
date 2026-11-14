// PORTED FROM: bitfield-packages/packages/chat/show/resolve-source-session-ref.test.ts @ e99ac5976
import { describe, expect, it } from 'vitest';
import { resolveInitialConversationSourceSessionRef } from './resolve-source-session-ref';

describe('resolveInitialConversationSourceSessionRef', () => {
  it('does not attach a source session for a new local-model turn', () => {
    expect(resolveInitialConversationSourceSessionRef({
      launch: { argv: ['ollama', 'run'] },
      shouldResumeSourceSession: false,
      selectedSessionId: null,
    })).toBeNull();
  });

  it('keeps the selected source session when the process launch can resume it', () => {
    expect(resolveInitialConversationSourceSessionRef({
      launch: {
        argv: ['claude'],
        resumeArgv: ['claude', '--resume', { value: 'sessionId' }],
      },
      shouldResumeSourceSession: true,
      selectedSessionId: 'session-123',
    })).toBe('session-123');
  });

  it('does not claim source-session continuity when the launch has no resume path', () => {
    expect(resolveInitialConversationSourceSessionRef({
      launch: { argv: ['some-cli'] },
      shouldResumeSourceSession: true,
      selectedSessionId: 'session-123',
    })).toBeNull();
  });
});
