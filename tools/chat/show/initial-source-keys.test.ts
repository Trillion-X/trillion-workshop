// PORTED FROM: bitfield-packages/packages/chat/show/initial-source-keys.test.ts @ e99ac5976
import { describe, expect, it } from 'vitest';
import { focusConversationKey, focusSourceKey, initialSourceKeys } from './initial-source-keys';

describe('initialSourceKeys', () => {
  it('pins to a single channel source key when focusSource is present', () => {
    expect([...initialSourceKeys({ focusSource: 'channel:telegram' })]).toEqual(['channel:telegram']);
  });

  it('is generic over the key space — an observed source pins just the same', () => {
    expect([...initialSourceKeys({ focusSource: 'observed:imessage-sam' })]).toEqual([
      'observed:imessage-sam',
    ]);
  });

  it('fails open to the empty "all sources" set when no surfaceInput is given', () => {
    expect(initialSourceKeys(undefined).size).toBe(0);
  });

  it('fails open when focusSource is absent, empty, or the wrong type', () => {
    expect(initialSourceKeys({}).size).toBe(0);
    expect(initialSourceKeys({ focusSource: '' }).size).toBe(0);
    expect(initialSourceKeys({ focusSource: '   ' }).size).toBe(0);
    expect(initialSourceKeys({ focusSource: 42 as unknown as string }).size).toBe(0);
    expect(initialSourceKeys({ focusSource: ['channel:telegram'] as unknown as string }).size).toBe(0);
  });

  it('exposes a stable key so embedded chat can react to a changed selection', () => {
    expect(focusSourceKey({ focusSource: ' ai-agent-profile:operator ' }))
      .toBe('ai-agent-profile:operator');
    expect(focusSourceKey({})).toBe('');
  });
});

describe('focusConversationKey', () => {
  it('reads a generic conversation selector from surface DATA', () => {
    expect(focusConversationKey({ focusConversation: ' morning-2026-08-22 ' }))
      .toBe('morning-2026-08-22');
  });

  it('fails open when the selector is absent or malformed', () => {
    expect(focusConversationKey()).toBe('');
    expect(focusConversationKey({ focusConversation: 42 })).toBe('');
  });
});
