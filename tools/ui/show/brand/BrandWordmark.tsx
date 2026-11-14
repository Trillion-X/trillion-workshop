// parts/ui/show/brand/BrandWordmark.tsx
//
// Brand wordmark + 8-dot mark. Generic: label and className are props, the
// mark is pure presentation styled by the consuming surface's stylesheet
// (`account-auth-wordmark` / `account-auth-mark` rule family by default).
// The label is required: the caller names the product, this part never does.

import React from 'react';
import { Container } from '../container';

export interface BrandWordmarkProps {
  className?: string;
  label: string;
}

export function BrandWordmark({
  className = 'account-auth-wordmark',
  label,
}: BrandWordmarkProps) {
  return (
    <Container className={className} aria-label={label}>
      <span className="account-auth-mark" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index} />
        ))}
      </span>
      <strong>{label}</strong>
    </Container>
  );
}
