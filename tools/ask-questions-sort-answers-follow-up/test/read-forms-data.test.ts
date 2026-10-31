// packages/ask-questions-sort-answers-follow-up/read-data/read-forms-data.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  readCapabilityRows,
  readCapabilityRegistry,
  readQuestionSequences,
  readFirstQuestionSequence,
  readQuestionSequenceById,
} from '../read-data/read-forms-data.ts';

// Rows arrive wrapped (`{payload}`) OR bare — the decoder handles both.
const CAP_ENTRY = [
  { payload: { kind: 'question-type-capability', questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string' } },
  { kind: 'question-type-capability', questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', validate: { rules: { min: 1, max: 5 } } },
  { payload: { kind: 'something-else', questionTypeId: 'nope' } }, // ignored
  { payload: { kind: 'question-type-capability', questionTypeId: 'broken' } }, // missing inputComponentKey → dropped
];

const SEQ_ENTRY = [
  {
    payload: {
      kind: 'question-sequence',
      formId: 'intake',
      title: 'Player Intake',
      questions: [
        { questionId: 'q1', questionTypeId: 'text', label: 'Name', required: true },
        { questionId: 'q2', questionTypeId: 'choice', label: 'Level', options: [{ label: 'New', value: 'new' }, { value: 'pro' }] },
        { questionTypeId: 'text' }, // missing questionId → dropped
      ],
    },
  },
  { payload: { kind: 'not-a-sequence' } }, // ignored
];

describe('readCapabilityRows / readCapabilityRegistry', () => {
  it('decodes wrapped + bare rows and drops malformed/foreign rows', () => {
    const rows = readCapabilityRows(CAP_ENTRY);
    expect(rows.map((r) => r.questionTypeId)).toEqual(['text', 'rating']);
    expect(rows.find((r) => r.questionTypeId === 'rating')?.coerce).toBe('number');
  });

  it('defaults an invalid coerce to string', () => {
    const rows = readCapabilityRows([{ payload: { kind: 'question-type-capability', questionTypeId: 'x', inputComponentKey: 'x', coerce: 'weird' } }]);
    expect(rows[0].coerce).toBe('string');
  });

  it('indexes by questionTypeId', () => {
    const reg = readCapabilityRegistry(CAP_ENTRY);
    expect(reg.get('rating')?.inputComponentKey).toBe('rating');
    expect(reg.has('text')).toBe(true);
  });

  it('is defensive against non-array / null input', () => {
    expect(readCapabilityRows(null)).toEqual([]);
    expect(readCapabilityRows({})).toEqual([]);
  });
});

describe('readQuestionSequences', () => {
  it('decodes a sequence and drops descriptors missing questionId', () => {
    const seqs = readQuestionSequences(SEQ_ENTRY);
    expect(seqs).toHaveLength(1);
    expect(seqs[0].formId).toBe('intake');
    expect(seqs[0].questions.map((q) => q.questionId)).toEqual(['q1', 'q2']);
  });

  it('fills an option label from its value when missing', () => {
    const q2 = readQuestionSequences(SEQ_ENTRY)[0].questions[1];
    expect(q2.options).toEqual([{ label: 'New', value: 'new' }, { label: 'pro', value: 'pro' }]);
  });

  it('preserves a valid post-save owner action and drops malformed action DATA', () => {
    const rows = readQuestionSequences([{
      payload: {
        kind: 'question-sequence',
        formId: 'objective',
        questions: [
          {
            questionId: 'objective-text',
            questionTypeId: 'text',
            after_saved: {
              owner: 'ai-execution-history',
              action_ref: 'action:write-fleet-learning-record',
              input: { objective_answer_ref: 'answer:$run.scope_ref' },
            },
          },
          {
            questionId: 'malformed',
            questionTypeId: 'text',
            after_saved: { owner: 'ai-execution-history', input: [] },
          },
        ],
      },
    }]);

    expect(rows[0].questions[0].afterSaved).toEqual({
      owner: 'ai-execution-history',
      actionRef: 'action:write-fleet-learning-record',
      input: { objective_answer_ref: 'answer:$run.scope_ref' },
    });
    expect(rows[0].questions[1].afterSaved).toBeUndefined();
  });

  it('decodes suggestion_source feed bindings (snake_case DATA) with predicates, evidence refs, and max', () => {
    const [sequence] = readQuestionSequences([{
      payload: {
        kind: 'question-sequence',
        formId: 'feeds',
        questions: [{
          questionId: 'q-route',
          questionTypeId: 'text',
          label: 'Route',
          suggestion_source: {
            input_name: 'update-routes',
            label_path: ['serviceName'],
            value_path: ['serviceName'],
            evidence_ref_path: ['status_ref'],
            where: [{ path: ['can_send'], equals: true }],
            max: 6,
          },
        }],
      },
    }]);

    expect(sequence.questions[0].suggestion_source).toEqual({
      input_name: 'update-routes',
      label_path: ['serviceName'],
      value_path: ['serviceName'],
      evidence_ref_path: ['status_ref'],
      where: [{ path: ['can_send'], equals: true }],
      max: 6,
    });
  });

  it('decodes options_source (camelCase also accepted) and drops malformed bindings', () => {
    const [sequence] = readQuestionSequences([{
      payload: {
        kind: 'question-sequence',
        formId: 'feeds',
        questions: [
          {
            questionId: 'q-a',
            questionTypeId: 'choice',
            label: 'A',
            optionsSource: { input_name: 'opts', label_path: ['label'], value_path: ['value'] },
          },
          {
            questionId: 'q-b',
            questionTypeId: 'text',
            label: 'B',
            suggestion_source: { input_name: '', label_path: ['x'], value_path: ['x'] },
          },
          {
            questionId: 'q-c',
            questionTypeId: 'text',
            label: 'C',
            suggestion_source: { input_name: 'ok', label_path: [], value_path: ['x'] },
          },
        ],
      },
    }]);

    expect(sequence.questions[0].options_source).toEqual({
      input_name: 'opts',
      label_path: ['label'],
      value_path: ['value'],
    });
    // empty input name / empty path → binding dropped entirely, never half-kept
    expect(sequence.questions[1].suggestion_source).toBeUndefined();
    expect(sequence.questions[2].suggestion_source).toBeUndefined();
  });

  it('decodes generic one-prompt presentation DATA without changing question semantics', () => {
    const [sequence] = readQuestionSequences([{
      payload: {
        kind: 'question-sequence',
        formId: 'stewardship',
        title: 'Stewardship',
        presentation: {
          mode: 'one-prompt-at-a-time',
          back_label: 'Previous',
          next_label: 'Next setting',
          submit_label: 'Save settings',
        },
        questions: [{ questionId: 'scope', questionTypeId: 'text', label: 'Scope' }],
      },
    }]);

    expect(sequence.presentation).toEqual({
      mode: 'one-prompt-at-a-time',
      backLabel: 'Previous',
      nextLabel: 'Next setting',
      submitLabel: 'Save settings',
    });
    expect(sequence.questions[0].label).toBe('Scope');
  });

  it('readFirstQuestionSequence returns the first, or null when empty', () => {
    expect(readFirstQuestionSequence(SEQ_ENTRY)?.formId).toBe('intake');
    expect(readFirstQuestionSequence([])).toBeNull();
  });
});

describe('readQuestionSequenceById (surface names WHICH form it fills — L069/L090)', () => {
  // Two forms in the same app: the fragility fix must pick the NAMED one, not the first.
  const TWO_FORMS = [
    { payload: { kind: 'question-sequence', formId: 'intake', title: 'Player Intake', questions: [{ questionId: 'q1', questionTypeId: 'text', label: 'Name' }] } },
    { payload: { kind: 'question-sequence', formId: 'practice-session', title: 'Practice session, before and after', questions: [{ questionId: 'pre-focus', questionTypeId: 'text', label: 'Focus' }] } },
  ];

  it('selects the sequence bound by formId — NOT the first', () => {
    const s = readQuestionSequenceById(TWO_FORMS, 'practice-session');
    expect(s?.formId).toBe('practice-session');
    expect(s?.title).toBe('Practice session, before and after');
    // readFirstQuestionSequence would have returned 'intake' — the fragility this fixes.
    expect(readFirstQuestionSequence(TWO_FORMS)?.formId).toBe('intake');
  });

  it('returns null for an unknown / empty / absent id (caller falls back to first)', () => {
    expect(readQuestionSequenceById(TWO_FORMS, 'does-not-exist')).toBeNull();
    expect(readQuestionSequenceById(TWO_FORMS, '')).toBeNull();
    expect(readQuestionSequenceById(TWO_FORMS, undefined)).toBeNull();
    expect(readQuestionSequenceById(TWO_FORMS, null)).toBeNull();
  });

  it('is defensive against non-array / null input', () => {
    expect(readQuestionSequenceById(null, 'intake')).toBeNull();
    expect(readQuestionSequenceById({}, 'intake')).toBeNull();
  });
});
