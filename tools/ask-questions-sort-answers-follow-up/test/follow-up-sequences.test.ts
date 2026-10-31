// packages/ask-questions-sort-answers-follow-up/read-data/follow-up-sequences.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  selectFollowUpSequence,
  readFollowUpSequences,
  type FollowUpSequence,
} from '../read-data/follow-up-sequences.ts';

const SEQS: FollowUpSequence[] = [
  { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 's1', venueConfigAddress: 'venue::crm-upsert', delayHours: 0 }] },
  { kind: 'follow-up-sequence', segmentId: 'cold', steps: [{ stepId: 's1', delayHours: 48 }] },
];

describe('selectFollowUpSequence', () => {
  it('picks the sequence whose segmentId matches', () => {
    expect(selectFollowUpSequence('hot', SEQS)?.steps[0].venueConfigAddress).toBe('venue::crm-upsert');
  });
  it('returns null for an unsegmented respondent or an unknown segment', () => {
    expect(selectFollowUpSequence(null, SEQS)).toBeNull();
    expect(selectFollowUpSequence('warm', SEQS)).toBeNull();
  });
});

describe('readFollowUpSequences', () => {
  it('decodes wrapped + bare rows and drops malformed steps/sequences', () => {
    const raw = [
      { payload: { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 'a' }, { delayHours: 1 }] } },
      { kind: 'follow-up-sequence', segmentId: 'cold', steps: [] },
      { payload: { kind: 'not-a-sequence' } },
      { payload: { kind: 'follow-up-sequence' } }, // no segmentId → dropped
    ];
    const out = readFollowUpSequences(raw);
    expect(out.map((s) => s.segmentId)).toEqual(['hot', 'cold']);
    expect(out[0].steps.map((s) => s.stepId)).toEqual(['a']); // step missing stepId dropped
  });
  it('is null-safe', () => {
    expect(readFollowUpSequences(null)).toEqual([]);
  });
});
