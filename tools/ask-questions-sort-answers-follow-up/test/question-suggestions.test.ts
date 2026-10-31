// packages/ask-questions-sort-answers-follow-up/read-data/question-suggestions.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  resolveQuestionOptions,
  resolveQuestionSuggestions,
} from '../read-data/question-suggestions.ts';
import type { QuestionFeedBinding } from '../read-data/question-descriptor.ts';

const RECORDS_FEED = [
  { id: 'record::a', title: 'Ship the launch page' },
  { id: 'record::b', title: 'Fix onboarding drop-off' },
  { id: 'record::c', title: 'Fix onboarding drop-off' }, // duplicate value
  { id: 'record::d', title: '' },                          // empty label → dropped
  { id: 'record::e', other: 'no title' },                  // missing paths → dropped
  'not-an-object',                                         // malformed row → dropped
  null,
];

const CAPABILITY_FEED = [
  { id: 'conn-1', serviceName: 'Email', can_send: true, status_ref: 'status::email' },
  { id: 'conn-2', serviceName: 'Slack', can_send: false, status_ref: 'status::slack' },
  { id: 'conn-3', serviceName: 'Calendar', can_send: true, status_ref: 'status::calendar' },
];

const RECORDS_BINDING: QuestionFeedBinding = {
  input_name: 'records-suggestions',
  label_path: ['title'],
  value_path: ['title'],
  evidence_ref_path: ['id'],
  max: 4,
};

const CAPABILITY_BINDING: QuestionFeedBinding = {
  input_name: 'update-routes',
  label_path: ['serviceName'],
  value_path: ['serviceName'],
  evidence_ref_path: ['status_ref'],
  where: [{ path: ['can_send'], equals: true }],
  max: 6,
};

describe('resolveQuestionSuggestions', () => {
  it('blindly resolves label/value/evidence rows from a bound named feed', () => {
    const out = resolveQuestionSuggestions(RECORDS_BINDING, {
      'records-suggestions': RECORDS_FEED,
    });
    expect(out).toEqual([
      { label: 'Ship the launch page', value: 'Ship the launch page', evidenceRef: 'record::a' },
      { label: 'Fix onboarding drop-off', value: 'Fix onboarding drop-off', evidenceRef: 'record::b' },
    ]);
  });

  it('applies generic where predicates (capability rows: can_send only)', () => {
    const out = resolveQuestionSuggestions(CAPABILITY_BINDING, { 'update-routes': CAPABILITY_FEED });
    expect(out.map((s) => s.value)).toEqual(['Email', 'Calendar']);
    expect(out.every((s) => typeof s.evidenceRef === 'string')).toBe(true);
  });

  it('dedupes by value, drops malformed rows, and caps at max', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `job-${i}` }));
    const out = resolveQuestionSuggestions(
      { ...RECORDS_BINDING, max: 3 },
      { 'records-suggestions': many },
    );
    expect(out).toHaveLength(3);
  });

  it('hostile feeds: absent / unauthorized / empty / non-array stale shape → NO suggestions, NO fallback constants', () => {
    expect(resolveQuestionSuggestions(RECORDS_BINDING, undefined)).toEqual([]);
    expect(resolveQuestionSuggestions(RECORDS_BINDING, {})).toEqual([]);
    expect(resolveQuestionSuggestions(RECORDS_BINDING, { 'records-suggestions': [] })).toEqual([]);
    expect(resolveQuestionSuggestions(RECORDS_BINDING, { 'records-suggestions': { stale: true } })).toEqual([]);
    expect(resolveQuestionSuggestions(RECORDS_BINDING, { 'records-suggestions': null })).toEqual([]);
    // no hardcoded seed list can ever leak through an empty feed
    expect(JSON.stringify(resolveQuestionSuggestions(RECORDS_BINDING, {}))).not.toContain('show-results-here');
    expect(JSON.stringify(resolveQuestionSuggestions(RECORDS_BINDING, {}))).not.toContain('email-me');
  });

  it('drops a malformed binding (no input name / empty paths) without throwing', () => {
    expect(resolveQuestionSuggestions(undefined, { x: [] })).toEqual([]);
    expect(
      resolveQuestionSuggestions(
        { input_name: '', label_path: ['title'], value_path: ['title'] },
        { '': [] },
      ),
    ).toEqual([]);
    expect(
      resolveQuestionSuggestions(
        { input_name: 'x', label_path: [], value_path: ['title'] },
        { x: [{ title: 't' }] },
      ),
    ).toEqual([]);
  });

  it('resolves deeply nested paths blindly', () => {
    const out = resolveQuestionSuggestions(
      { input_name: 'nested', label_path: ['a', 'b', 'label'], value_path: ['a', 'b', 'value'] },
      { nested: [{ a: { b: { label: 'Deep', value: 'deep-value' } } }] },
    );
    expect(out).toEqual([{ label: 'Deep', value: 'deep-value' }]);
  });
});

describe('resolveQuestionOptions (capability-derived bounded options)', () => {
  it('maps feed rows to options', () => {
    const out = resolveQuestionOptions(CAPABILITY_BINDING, { 'update-routes': CAPABILITY_FEED });
    expect(out).toEqual([
      { label: 'Email', value: 'Email' },
      { label: 'Calendar', value: 'Calendar' },
    ]);
  });

  it('returns undefined only when no binding exists; a bound-but-empty feed yields [] (free input, never fallback constants)', () => {
    expect(resolveQuestionOptions(undefined, {})).toBeUndefined();
    expect(resolveQuestionOptions(CAPABILITY_BINDING, {})).toEqual([]);
  });
});
