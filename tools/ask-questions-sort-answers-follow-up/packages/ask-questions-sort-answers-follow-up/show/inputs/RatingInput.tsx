// packages/ask-questions-sort-answers-follow-up/show/inputs/RatingInput.tsx
//
// Scalar question input. Renders min..max as a single-select SegmentedControl
// (numeric), emitting a NUMBER. Composes ui SegmentedControl inside the shared
// QuestionField. Zero inline styling. Bounds are per-question DATA (default 1..5
// matches the seed `rating` capability row).

import React from 'react';
import { SegmentedControl } from '@/packages/ui/show/segmented-control/SegmentedControl';
import { QuestionField } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/QuestionField';
import type { QuestionInputProps } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';

export function buildScaleItems(min: number, max: number): { id: string; label: string }[] {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const items: { id: string; label: string }[] = [];
  for (let n = lo; n <= hi; n += 1) items.push({ id: String(n), label: String(n) });
  return items;
}

export function RatingInput({
  questionId,
  label,
  value,
  onChange,
  required,
  error,
  min,
  max,
}: QuestionInputProps) {
  const items = buildScaleItems(min ?? 1, max ?? 5);
  return (
    <QuestionField htmlFor={questionId} label={label} required={required} error={error}>
      <SegmentedControl
        ariaLabel={label}
        value={value == null ? '' : String(value)}
        items={items}
        onValueChange={(next) => onChange(Number(next))}
      />
    </QuestionField>
  );
}
