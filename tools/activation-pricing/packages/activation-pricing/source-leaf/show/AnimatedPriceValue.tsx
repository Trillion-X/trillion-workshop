'use client';

import * as React from 'react';

export type AnimatedPriceValueProps = {
  value: string;
  label?: string;
  reducedMotion?: boolean;
};

export function AnimatedPriceValue({ value, label, reducedMotion = false }: AnimatedPriceValueProps) {
  return (
    <span data-motion={reducedMotion ? 'instant' : 'soft'} aria-label={label}>
      {value}
    </span>
  );
}
