// packages/ask-questions-sort-answers-follow-up/read-data/fill-screen-model.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  buildFillScreenModel,
  mergeRules,
} from '../read-data/fill-screen-model.ts';
import {
  indexCapabilities,
  type QuestionDescriptor,
  type QuestionTypeCapability,
} from '../read-data/question-descriptor.ts';

const CAPS: QuestionTypeCapability[] = [
  { questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'choice', inputComponentKey: 'choice', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', validate: { rules: { required: false, min: 1, max: 5 } } },
];
const REG = indexCapabilities(CAPS);

const QUESTIONS: QuestionDescriptor[] = [
  { questionId: 'q-name', questionTypeId: 'text', label: 'Your name', required: true, validation: { required: true } },
  { questionId: 'q-level', questionTypeId: 'choice', label: 'Level', options: [{ label: 'New', value: 'new' }, { label: 'Pro', value: 'pro' }] },
  { questionId: 'q-rating', questionTypeId: 'rating', label: 'Rate us' },
];

describe('mergeRules', () => {
  it('lets the per-question override win over the capability default', () => {
    expect(mergeRules({ required: false, min: 1 }, { required: true }))
      .toEqual({ required: true, min: 1 });
  });
});

describe('buildFillScreenModel', () => {
  it('resolves each question to its inputComponentKey + coerce from the registry', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, {});
    expect(m.rows.map((r) => r.inputComponentKey)).toEqual(['text', 'choice', 'rating']);
    expect(m.rows.map((r) => r.coerce)).toEqual(['string', 'string', 'number']);
  });

  it('does NOT reveal required-errors for untouched answers by default', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, {});
    expect(m.rows[0].error).toBeNull();      // untouched required → no visible error yet
    expect(m.rows[0].valid).toBe(false);     // ...but truly invalid
    expect(m.allValid).toBe(false);
    expect(m.firstInvalidId).toBe('q-name');
  });

  it('reveals errors for all when revealErrors=true (submit attempt)', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, {}, { revealErrors: true });
    expect(m.rows[0].error).toBe('This question is required');
  });

  it('is allValid once required answers are entered + within bounds', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, { 'q-name': 'Bri', 'q-rating': 3 }, { revealErrors: true });
    expect(m.allValid).toBe(true);
    expect(m.firstInvalidId).toBeNull();
    expect(m.rows.every((r) => r.error === null)).toBe(true);
  });

  it('flags an out-of-bounds rating answer', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, { 'q-name': 'Bri', 'q-rating': 9 }, { revealErrors: true });
    expect(m.allValid).toBe(false);
    expect(m.rows[2].error).toBe('Must be at most 5');
  });

  it('gracefully renders an unknown question type as text (never drops it)', () => {
    const q: QuestionDescriptor[] = [{ questionId: 'q-x', questionTypeId: 'signature', label: 'Sign' }];
    const m = buildFillScreenModel(q, REG, {});
    expect(m.rows[0].inputComponentKey).toBe('text');
    expect(m.rows[0].coerce).toBe('string');
  });

  it('resolves DATA-bound suggestion chips from current feeds; absent feed = none, never fallback constants', () => {
    const q: QuestionDescriptor[] = [{
      questionId: 'q-objective',
      questionTypeId: 'text',
      label: 'Objective',
      suggestion_source: {
        input_name: 'objective-suggestions',
        label_path: ['title'],
        value_path: ['title'],
        evidence_ref_path: ['id'],
      },
    }];
    const withFeed = buildFillScreenModel(q, REG, {}, {
      suggestionFeeds: { 'objective-suggestions': [{ id: 'r1', title: 'Ship the launch page' }] },
    });
    expect(withFeed.rows[0].suggestions).toEqual([
      { label: 'Ship the launch page', value: 'Ship the launch page', evidenceRef: 'r1' },
    ]);

    // Hostile/absent feed: zero chips, and NO seed constants can leak through.
    const noFeed = buildFillScreenModel(q, REG, {}, { suggestionFeeds: {} });
    expect(noFeed.rows[0].suggestions).toEqual([]);
    expect(JSON.stringify(noFeed)).not.toContain('show-results-here');
  });

  it('derives options ONLY from an options_source feed — empty feed means free input, never authored fallback options', () => {
    const q: QuestionDescriptor[] = [{
      questionId: 'q-route',
      questionTypeId: 'choice',
      label: 'Route',
      // authored static options exist, but options_source must OVERRIDE them
      options: [{ label: 'Never', value: 'never' }],
      options_source: {
        input_name: 'routes',
        label_path: ['name'],
        value_path: ['name'],
        where: [{ path: ['can_send'], equals: true }],
      },
    }];
    const withFeed = buildFillScreenModel(q, REG, {}, {
      suggestionFeeds: { routes: [
        { name: 'Email', can_send: true },
        { name: 'Slack', can_send: false },
      ] },
    });
    expect(withFeed.rows[0].resolvedOptions).toEqual([{ label: 'Email', value: 'Email' }]);

    const noFeed = buildFillScreenModel(q, REG, {}, {});
    expect(noFeed.rows[0].resolvedOptions).toEqual([]);
  });

  it('keeps authored static options when no options_source is bound', () => {
    const m = buildFillScreenModel(QUESTIONS, REG, {});
    expect(m.rows[1].resolvedOptions).toEqual(QUESTIONS[1].options);
  });
});
