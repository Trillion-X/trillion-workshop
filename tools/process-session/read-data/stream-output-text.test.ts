import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { extractStreamText, type StreamTextSpec } from './stream-output-text.ts';

// A claude stream-json text-delta spec (authored as DATA, not code): concatenate
// event.delta.text from content_block_delta / text_delta lines; ignore everything else.
const claudeSpec: StreamTextSpec = {
  lineFormat: 'jsonl',
  events: [{
    when: [
      { path: ['type'], equals: 'stream_event' },
      { path: ['event', 'type'], equals: 'content_block_delta' },
      { path: ['event', 'delta', 'type'], equals: 'text_delta' },
    ],
    textPaths: [['event', 'delta', 'text']],
  }],
};

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

describe('extractStreamText — DATA-driven, no CLI/format branch', () => {
  it('concatenates incremental text_delta chunks into the growing answer, ignoring non-text lines', () => {
    const raw = jsonl(
      { type: 'system', subtype: 'init' },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } } }, // thinking sig — ignored
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } } },
      { type: 'result', subtype: 'success' },
    );
    expect(extractStreamText(raw, claudeSpec)).toBe('Hello, world');
  });

  it('skips a partial trailing line (incomplete JSON) until it completes', () => {
    const complete = jsonl({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'abc' } } });
    // a half-written next line (no newline, invalid JSON) must not throw or corrupt output
    const partial = complete + '\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_de';
    expect(extractStreamText(partial, claudeSpec)).toBe('abc');
  });

  it('the SAME extractor handles a totally different DATA shape with zero code change (deletion test)', () => {
    // A fabricated non-AI JSONL source: text lives at a different path, different predicate.
    const otherSpec: StreamTextSpec = {
      lineFormat: 'jsonl',
      events: [{ when: [{ path: ['kind'], equals: 'chunk' }], textPaths: [['body']] }],
    };
    const raw = jsonl({ kind: 'meta' }, { kind: 'chunk', body: 'one ' }, { kind: 'chunk', body: 'two' });
    expect(extractStreamText(raw, otherSpec)).toBe('one two');
  });

  it('tolerates a superset rule shape (emit.textPaths) as authored by chat-style DATA', () => {
    const supersetSpec = {
      lineFormat: 'jsonl',
      events: [{ when: [{ path: ['type'], equals: 'assistant' }], emit: { kind: 'text', textPaths: [['content']] } }],
    } as unknown as StreamTextSpec;
    const raw = jsonl({ type: 'assistant', content: 'final answer' });
    expect(extractStreamText(raw, supersetSpec)).toBe('final answer');
  });
});
