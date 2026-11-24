// packages/ask-questions-sort-answers-follow-up/show/inputs/LinkInput.tsx
//
// Link question input: one web address, typed or pasted, with the phone's web-address keyboard. The shared checker's
// link rule (data/question-types.json) says whether it is a full link.

import React from 'react';
import { Input } from '../../../../../ui/show/input/Input';
import type { QuestionInputProps } from '../../../../read-data/question-input-contract';

export function LinkInput({ questionId, label, value, onChange, placeholder, required, error }: QuestionInputProps) {
  return (
    <Input
      id={questionId}
      type="url"
      inputMode="url"
      autoComplete="url"
      label={`${label}${required ? ' *' : ''}`}
      required={required}
      placeholder={placeholder ?? 'https://'}
      value={value == null ? '' : String(value)}
      error={error ?? undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
