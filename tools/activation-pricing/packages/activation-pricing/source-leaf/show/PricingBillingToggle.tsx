'use client';

import * as React from 'react';

export type GenericChoice = {
  id: string;
  label: string;
  disabled?: boolean;
};

export type PricingBillingToggleProps = {
  label: string;
  choices: GenericChoice[];
  selectedId?: string;
  onSelect?: (id: string) => void;
};

export function PricingBillingToggle({ label, choices, selectedId, onSelect }: PricingBillingToggleProps) {
  return (
    <fieldset aria-label={label}>
      <legend>{label}</legend>
      <div role="radiogroup" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={choice.id === selectedId}
            disabled={choice.disabled}
            onClick={() => onSelect?.(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
