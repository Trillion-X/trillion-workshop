// packages/notifications/show/setting-option-card.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A single selectable option, rendered as a reference-grounded card (icon +
// strong label + description + selected ring + "current" badge). Pure and
// blind: it consumes one HumanOptionView and reports selection by the option's
// OPAQUE id. It never names a mode, a key, or a route.
//
// Reference anatomy (Mobbin CS-145 contract): "Use card/radio primitives for
// mode selection", "labels, descriptions, and selected state", "one mode per
// row/card on phone and watch", "badges for Current mode". Option labels must
// be visually stronger than descriptions.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain literals. All text comes from the HumanOptionView data and the
//    generic copy constant; no mode key or backend word appears in source.
// 2. Composes only shared ui primitives (Card, Container, Text, NamedIcon,
//    Badge, Icon) — no raw div/span/p, no inline styling (L065).
// 3. Selection is reported by `option.id` verbatim — the card never interprets
//    it.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Badge, Card, Container, NamedIcon, Text } from '../../ui';
import { CURRENT_BADGE_LABEL } from '../read-data/setting-copy-table';
import type { HumanOptionView } from '../read-data/project-setting-view';

export interface SettingOptionCardProps {
  option: HumanOptionView;
  disabled?: boolean;
  onSelect: (optionId: string) => void;
}

export function SettingOptionCard({ option, disabled, onSelect }: SettingOptionCardProps) {
  return (
    <Card
      variant="nested"
      layout="row"
      padding="md"
      interactive={!disabled}
      selected={option.selected}
      role="radio"
      aria-checked={option.selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-setting-option
      data-selected={option.selected ? 'true' : 'false'}
      data-current={option.isCurrent ? 'true' : 'false'}
      onClick={() => {
        if (!disabled) onSelect(option.id);
      }}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(option.id);
        }
      }}
      className="items-start gap-4"
    >
      <NamedIcon name={option.iconName} size="lg" className="mt-0.5 shrink-0" />

      <Container layout="vertical" gap="xs" padding="none" className="min-w-0 flex-1">
        <Text variant="body" weight="medium">
          {option.label}
        </Text>
        {option.description ? (
          <Text variant="body-xs" color="faint">
            {option.description}
          </Text>
        ) : null}
      </Container>

      <Container layout="horizontal" gap="sm" padding="none" alignItems="center" className="shrink-0">
        {option.isCurrent ? (
          <Badge variant="success" size="sm">
            {CURRENT_BADGE_LABEL}
          </Badge>
        ) : null}
        {option.selected ? (
          <NamedIcon name="Check" size="md" className="text-[var(--status-success)]" />
        ) : null}
      </Container>
    </Card>
  );
}
