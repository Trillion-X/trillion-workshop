// packages/ask-questions-sort-answers-follow-up/read-data/synthesis-result.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  SYNTHESIS_RESULT_KIND,
  latestSynthesisResult,
  resultKeyFor,
  slugify,
  synthesisResultAddress,
} from '../read-data/synthesis-result.ts';

const row = (r: Record<string, unknown>) => ({ address: 'a', payload: { kind: SYNTHESIS_RESULT_KIND, ...r } });

describe('synthesis-result persistence primitive', () => {
  it('slugify + resultKeyFor: explicit key wins, else slug of title, else default', () => {
    expect(slugify('Your Prime Directive!')).toBe('your-prime-directive');
    expect(resultKeyFor('codex', 'Your Codex')).toBe('codex');
    expect(resultKeyFor(undefined, 'Your Codex')).toBe('your-codex');
    expect(resultKeyFor('', '')).toBe('default');
  });

  it('address is stable + 2-segment-feed addressed per (sequence,key)', () => {
    expect(synthesisResultAddress('conviction-corpus-interview-v1', 'codex')).toBe(
      'package::ask-questions-sort-answers-follow-up::synthesis-result::conviction-corpus-interview-v1::codex',
    );
    // distinct surfaces sharing one sequence never collide
    expect(synthesisResultAddress('s', 'convictions')).not.toBe(synthesisResultAddress('s', 'codex'));
  });

  it('latestSynthesisResult returns the newest text for (sequence,key)', () => {
    const published = [
      row({ sequence_id: 's', result_key: 'codex', text: 'old codex', produced_at: '2026-07-04T10:00:00Z' }),
      row({ sequence_id: 's', result_key: 'codex', text: 'new codex', produced_at: '2026-07-04T12:00:00Z' }),
      row({ sequence_id: 's', result_key: 'prime-directive', text: 'a directive', produced_at: '2026-07-04T13:00:00Z' }),
    ];
    expect(latestSynthesisResult(published, 's', 'codex')).toBe('new codex');
    expect(latestSynthesisResult(published, 's', 'prime-directive')).toBe('a directive');
  });

  it('does NOT cross sequences or keys, ignores blank/other kinds (fail closed to null)', () => {
    const published = [
      row({ sequence_id: 'other', result_key: 'codex', text: 'wrong seq', produced_at: '2026-07-04T12:00:00Z' }),
      row({ sequence_id: 's', result_key: 'other', text: 'wrong key', produced_at: '2026-07-04T12:00:00Z' }),
      row({ sequence_id: 's', result_key: 'codex', text: '   ', produced_at: '2026-07-04T12:00:00Z' }),
      { address: 'x', payload: { kind: 'answer-fact', sequence_id: 's', result_key: 'codex', text: 'not a synthesis' } },
    ];
    expect(latestSynthesisResult(published, 's', 'codex')).toBeNull();
    expect(latestSynthesisResult(undefined, 's', 'codex')).toBeNull();
    expect(latestSynthesisResult({ rows: published }, 's', 'codex')).toBeNull();
  });
});
