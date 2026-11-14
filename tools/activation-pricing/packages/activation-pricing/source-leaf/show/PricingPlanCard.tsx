'use client';

import * as React from 'react';
import { AnimatedPriceValue } from './AnimatedPriceValue.tsx';

export type GenericOptionCardField = {
  id: string;
  label: string;
  formatted: string;
};

export type GenericOptionCardAction = {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
};

export type PricingPlanCardProps = {
  id: string;
  title: string;
  summary?: string;
  fields: GenericOptionCardField[];
  action?: GenericOptionCardAction;
  emphasized?: boolean;
  onAction?: (id: string) => void;
};

export function PricingPlanCard({
  id,
  title,
  summary,
  fields,
  action,
  emphasized = false,
  onAction,
}: PricingPlanCardProps) {
  return (
    <article data-option-id={id} data-emphasis={emphasized ? 'true' : 'false'}>
      <header>
        <h3>{title}</h3>
        {summary ? <p>{summary}</p> : null}
      </header>
      <dl>
        {fields.map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>
              <AnimatedPriceValue value={field.formatted} label={`${field.label}: ${field.formatted}`} />
            </dd>
          </div>
        ))}
      </dl>
      {action ? (
        <button type="button" disabled={!action.enabled} onClick={() => onAction?.(action.id)}>
          {action.enabled ? action.label : action.disabledReason ?? action.label}
        </button>
      ) : null}
    </article>
  );
}
