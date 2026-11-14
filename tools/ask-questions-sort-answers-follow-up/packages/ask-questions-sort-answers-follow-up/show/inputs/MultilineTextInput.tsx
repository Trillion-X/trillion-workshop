// packages/ask-questions-sort-answers-follow-up/show/inputs/MultilineTextInput.tsx
//
// Free-value question input for reflective, multi-sentence answers. Composes the
// canonical ui Textarea (self-contained label + error, auto-growing). Same
// QuestionInputProps contract as TextInput — the only difference is a roomy
// multi-line surface. Selected purely by DATA: a question-type-capability whose
// inputComponentKey is 'long-text'. Zero inline styling.

import React from 'react';
import { Textarea } from '@/packages/ui/show/input/Textarea';
import type { QuestionInputProps } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';

export function MultilineTextInput({
  questionId,
  label,
  value,
  onChange,
  placeholder,
  error,
}: QuestionInputProps) {
  return (
    <Textarea
      id={questionId}
      label={label}
      placeholder={placeholder}
      rows={4}
      autoGrow
      value={value == null ? '' : String(value)}
      error={error ?? undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
