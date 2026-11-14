import React from 'react';
import { Input } from '@/packages/ui/show/input/Input';
import type { QuestionInputProps } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';

/** Generic bounded numeric answer leaf. Empty stays empty so the shared
 * coercion/validation owner can distinguish missing from zero. */
export function NumberInput({
  questionId,
  label,
  value,
  onChange,
  placeholder,
  required,
  min,
  max,
  error,
}: QuestionInputProps) {
  return (
    <Input
      id={questionId}
      type="number"
      inputMode="decimal"
      step="any"
      min={min ?? undefined}
      max={max ?? undefined}
      label={`${label}${required ? ' *' : ''}`}
      required={required}
      placeholder={placeholder}
      value={value == null ? '' : String(value)}
      error={error ?? undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
