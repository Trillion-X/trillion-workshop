import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { answerLinesForSequence, labelMapForSequence } from '../read-data/synthesis-answer-lines.ts';

// An answer-fact row as the live `published-records` feed surfaces it. The fold
// (fold-answer-facts) groups by formId + submission; here one submission.
const answerFact = (formId: string, questionId: string, value: unknown, answeredAt: string) => ({
  payload: {
    kind: 'answer-fact',
    formId,
    questionId,
    value,
    answeredAt,
    respondentId: 'r1',
    submissionId: 'sub-1',
  },
});

const sequence = (formId: string, questions: Array<{ questionId: string; label: string }>) => ({
  payload: { kind: 'question-sequence', formId, title: 'T', questions },
});

const SEQ = sequence('sls-aa-framework-v1', [
  { questionId: 'situation', label: 'What situation do you want to see more clearly?' },
  { questionId: 'focus', label: 'What one thing would change the most?' },
]);

describe('labelMapForSequence', () => {
  it('maps questionId -> label from the published question-sequence', () => {
    const m = labelMapForSequence([SEQ], 'sls-aa-framework-v1');
    expect(m.get('situation')).toBe('What situation do you want to see more clearly?');
    expect(m.get('focus')).toBe('What one thing would change the most?');
  });
  it('is empty for an unknown sequence or missing id (fully generic, never throws)', () => {
    expect(labelMapForSequence([SEQ], 'nope').size).toBe(0);
    expect(labelMapForSequence([SEQ], undefined).size).toBe(0);
    expect(labelMapForSequence(null, 'sls-aa-framework-v1').size).toBe(0);
  });
});

describe('answerLinesForSequence — labels the answers so per-question reasoning works', () => {
  it('prefixes each answer with its question label', () => {
    const rows = [
      SEQ,
      answerFact('sls-aa-framework-v1', 'situation', 'A hard conversation with my co-founder', '2026-07-05T10:00:00Z'),
      answerFact('sls-aa-framework-v1', 'focus', 'Rebuilding trust', '2026-07-05T10:01:00Z'),
    ];
    const lines = answerLinesForSequence(rows, 'sls-aa-framework-v1');
    expect(lines).toContain('What situation do you want to see more clearly?: A hard conversation with my co-founder');
    expect(lines).toContain('What one thing would change the most?: Rebuilding trust');
  });

  it('falls back to the bare answer when no label is known (generic, no vocabulary baked in)', () => {
    const rows = [answerFact('unlabeled-form', 'q1', 'just the answer', '2026-07-05T10:00:00Z')];
    const lines = answerLinesForSequence(rows, 'unlabeled-form');
    expect(lines).toEqual(['just the answer']);
  });

  it('drops empty answers and returns [] when nothing is answered', () => {
    expect(answerLinesForSequence([SEQ], 'sls-aa-framework-v1')).toEqual([]);
    const rows = [SEQ, answerFact('sls-aa-framework-v1', 'situation', '   ', '2026-07-05T10:00:00Z')];
    expect(answerLinesForSequence(rows, 'sls-aa-framework-v1')).toEqual([]);
  });
});
