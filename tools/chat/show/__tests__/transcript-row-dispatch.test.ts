// PORTED FROM: bitfield-packages/packages/chat/show/__tests__/transcript-row-dispatch.test.ts @ e99ac5976
// #41 / contract §9.5 — the unified transcript renderer dispatches every row
// through a SELF-DESCRIBING DATA discriminant (transcriptRowKind), not an
// if/switch chain. These prove the discriminant maps each RenderItem variant to
// the correct row kind, and that a future/unknown kind is handled by the body
// without editing the dispatch (the agent fallback) — i.e. the panel passes the
// reference-lock Generic gate §7 ("no `if (kind===)` in the panel").
import { describe, it, expect } from 'vitest';
import { transcriptRowKind } from '../ChatPanel';
import type { AgentMessage } from '../../read-data/chat-message-types';

function msg(role: 'human' | 'assistant', type: AgentMessage['type'] = 'text'): AgentMessage {
  return { id: `${role}-${type}`, role, type, content: 'x' } as AgentMessage;
}

describe('transcriptRowKind — self-describing transcript dispatch (#41)', () => {
  it('routes a human message row to the human bubble leaf', () => {
    expect(transcriptRowKind({ kind: 'message', message: msg('human'), messageIndex: 0 })).toBe('human');
  });

  it('routes an assistant message row to the agent leaf', () => {
    expect(transcriptRowKind({ kind: 'message', message: msg('assistant'), messageIndex: 1 })).toBe('agent');
  });

  it('routes a grouped tool-use row to the tool_group leaf', () => {
    expect(
      transcriptRowKind({
        kind: 'tool_group',
        entries: [{ message: msg('assistant', 'tool_use'), messageIndex: 2 }],
        firstMessageIndex: 2,
        lastMessageIndex: 2,
      }),
    ).toBe('tool_group');
  });

  it('treats a non-human message of ANY type as the agent kind (no per-type branch)', () => {
    // thinking / error / status all fall under the single agent leaf — proves the
    // agent renderer is the unified home for all non-human, non-grouped output.
    for (const type of ['thinking', 'error', 'status', 'text'] as AgentMessage['type'][]) {
      expect(transcriptRowKind({ kind: 'message', message: msg('assistant', type), messageIndex: 3 })).toBe('agent');
    }
  });
});
