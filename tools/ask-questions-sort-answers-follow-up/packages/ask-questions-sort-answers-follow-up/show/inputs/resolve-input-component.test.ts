// packages/ask-questions-sort-answers-follow-up/show/inputs/resolve-input-component.test.ts
import { describe, expect, it } from 'vitest';
import {
  QUESTION_INPUT_COMPONENTS,
  resolveInputComponent,
  TextInput,
  MultilineTextInput,
  ChoiceInput,
  RatingInput,
} from '@/packages/ask-questions-sort-answers-follow-up/show/inputs';
import { buildScaleItems } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/RatingInput';

describe('input dispatch map (L090 — no switch on questionTypeId)', () => {
  it('binds the declared input keys', () => {
    expect(Object.keys(QUESTION_INPUT_COMPONENTS).sort()).toEqual(['choice', 'evidence-reference', 'long-text', 'number', 'rating', 'text']);
  });

  it('resolves each key to its leaf', () => {
    expect(resolveInputComponent('text')).toBe(TextInput);
    expect(resolveInputComponent('long-text')).toBe(MultilineTextInput);
    expect(resolveInputComponent('choice')).toBe(ChoiceInput);
    expect(resolveInputComponent('rating')).toBe(RatingInput);
  });

  it('falls back to text for unknown/empty keys (graceful, never drops a question)', () => {
    expect(resolveInputComponent('signature')).toBe(TextInput);
    expect(resolveInputComponent(null)).toBe(TextInput);
    expect(resolveInputComponent(undefined)).toBe(TextInput);
  });
});

describe('buildScaleItems (rating scale from DATA bounds)', () => {
  it('builds an inclusive 1..5 scale', () => {
    expect(buildScaleItems(1, 5).map((i) => i.label)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('normalizes reversed bounds', () => {
    expect(buildScaleItems(5, 1).map((i) => i.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('supports a non-1 start (e.g. 0..10 NPS)', () => {
    expect(buildScaleItems(0, 10)).toHaveLength(11);
  });
});
