// packages/ask-questions-sort-answers-follow-up/show/inputs/TextInput.tsx
//
// Free-value question input. Composes the canonical ui Textarea in AUTO-GROW mode:
// it starts at a single line (looks like a normal one-line field) and expands as
// the answer gets longer, so a long reflective answer is never clipped to one line.
// This is the maximally-capable default (L083) — short answers stay compact, long
// answers grow — so no question needs per-field configuration to hold long text.
// A roomier multi-line start is still available as the DATA-selected 'long-text'
// component (MultilineTextInput, rows=4). Zero inline styling.

import React from 'react';
import { Textarea } from '@/packages/ui/show/input/Textarea';
import type { QuestionInputProps } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';

export function TextInput({
  questionId,
  label,
  value,
  onChange,
  placeholder,
  required,
  error,
}: QuestionInputProps) {
  return (
    <Textarea
      id={questionId}
      label={label}
      required={required}
      placeholder={placeholder}
      rows={1}
      autoGrow
      maxHeight={480}
      value={value == null ? '' : String(value)}
      error={error ?? undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
