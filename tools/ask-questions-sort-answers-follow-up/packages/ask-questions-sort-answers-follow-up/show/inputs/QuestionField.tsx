// packages/ask-questions-sort-answers-follow-up/show/inputs/QuestionField.tsx
//
// Shared label + control + error wrapper for inputs that don't carry their own
// label/error (choice, rating). Composes ui Container + Text only — zero inline
// styling, zero raw div/span (L065/L066). The Input leaf is self-contained and
// does NOT use this (Input renders its own label/error).

import React from 'react';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';

export interface QuestionFieldProps {
  htmlFor?: string;
  label: string;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}

export function QuestionField({ htmlFor, label, required, error, children }: QuestionFieldProps) {
  return (
    <Container as="div" gap="sm" alignItems="stretch">
      <Text as="label" htmlFor={htmlFor} variant="label">
        {label}
        {required ? ' *' : ''}
      </Text>
      {children}
      {error ? (
        <Text variant="caption" color="error">
          {error}
        </Text>
      ) : null}
    </Container>
  );
}
