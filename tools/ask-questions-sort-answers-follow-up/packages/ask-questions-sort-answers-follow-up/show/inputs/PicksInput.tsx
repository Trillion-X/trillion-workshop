// packages/ask-questions-sort-answers-follow-up/show/inputs/PicksInput.tsx
//
// Picks question input: the question's options as rows to press, one pick or several (`multiple`), and an other option
// that opens a box for the person's own words (`other`). Composes the shared Coss ChoiceRows; the value it emits is the
// picks answer { picked, other? } the shared checker (read-data/validate-answer.ts) checks against the same options.

import React from 'react';
import { ChoiceRows, type ChoiceRowsValue } from '../../../../../ui/show/coss/choice-rows';
import { QuestionField } from './QuestionField';
import type { QuestionInputProps } from '../../../../read-data/question-input-contract';

function picksOf(value: unknown): ChoiceRowsValue | null {
  if (typeof value === 'string') return { picked: [value] };
  if (Array.isArray(value)) return { picked: value.map(String) };
  if (value && typeof value === 'object' && Array.isArray((value as ChoiceRowsValue).picked)) return value as ChoiceRowsValue;
  return null;
}

export function PicksInput({ questionId, label, value, onChange, options = [], multiple, other, placeholder, required, error }: QuestionInputProps) {
  return (
    <QuestionField htmlFor={questionId} label={label} required={required} error={error}>
      <ChoiceRows label={label} options={options} multiple={multiple} other={other} otherPlaceholder={placeholder} value={picksOf(value)} onChange={onChange} invalid={Boolean(error)} />
    </QuestionField>
  );
}
