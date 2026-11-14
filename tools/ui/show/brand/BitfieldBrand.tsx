// packages/ui/show/brand/BitfieldBrand.tsx
//
// Brand wordmark + 8-dot mark. Generic: label and className are props, the
// mark is pure presentation styled by the consuming surface's stylesheet
// (`account-auth-wordmark` / `account-auth-mark` rule family by default).

import React from 'react';
import { Container } from '../container';

export interface BitfieldBrandProps {
  className?: string;
  label?: string;
}

export function BitfieldBrand({
  className = 'account-auth-wordmark',
  label = 'Bitfield',
}: BitfieldBrandProps) {
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
