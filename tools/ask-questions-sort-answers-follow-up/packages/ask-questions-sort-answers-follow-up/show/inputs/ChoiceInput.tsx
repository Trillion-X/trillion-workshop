// packages/ask-questions-sort-answers-follow-up/show/inputs/ChoiceInput.tsx
//
// Bounded-choice question input. Composes ui SegmentedControl (single-select
// radiogroup) inside the shared QuestionField (label + error). Zero inline
// styling. Options are per-question DATA (the
// `options:[{label,value}]` shape, not redesigned).

import React from 'react';
import { SegmentedControl } from '../../../../../ui/show/segmented-control/SegmentedControl';
import { QuestionField } from './QuestionField';
import type { QuestionInputProps } from '../../../../read-data/question-input-contract';

export function ChoiceInput({
  questionId,
  label,
  value,
  onChange,
  options = [],
  required,
  error,
}: QuestionInputProps) {
  return (
    <QuestionField htmlFor={questionId} label={label} required={required} error={error}>
      <SegmentedControl
        ariaLabel={label}
        value={value == null ? '' : String(value)}
        items={options.map((o) => ({ id: o.value, label: o.label }))}
        onValueChange={(next) => onChange(next)}
      />
    </QuestionField>
  );
}
