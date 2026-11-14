// frontends/web/src/packages/ui/pricing/Pricing.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical pricing component with multiple display variants.
// Pass tiers as data + a variant flag for the display style.
//
// Variants:
//   - "selector"  — Side-by-side selectable cards (Founders Notes pattern)
//   - "accordion" — Expandable rows with descriptions (customer pattern)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ONE component, multiple display modes via variant prop
// 2. Tiers are pure data — component renders them
// 3. Uses ui/ components only — zero inline styles (L065)
// 4. onSelect callback when user picks a tier
// 5. L069: this IS the pricing primitive — all projects use it
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Text } from '../text';
import { Button } from '../button';
import { Container } from '../container';
import { Card } from '../card';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface PricingTier {
  /** Unique identifier */
  id: string;
  /** Display name (e.g., "monthly", "yearly", "lifetime") */
  title: string;
  /** Price display (e.g., "$100", "$500") */
  price: string;
  /** Price context (e.g., "per month", "per year", "one-time") */
  priceSubtext: string;
  /** Short description shown in accordion mode */
  subtitle?: string;
  /** Feature list shown in accordion expanded state */
  features?: string[];
}

export interface PricingProps {
  /** Display variant */
  variant: 'selector' | 'accordion';
  /** The pricing tiers to display */
  tiers: PricingTier[];
  /** Section title */
  title?: string;
  /** Section subtitle */
  subtitle?: string;
  /** CTA button text */
  ctaText?: string;
  /** Called when user selects a tier */
  onSelect?: (tierId: string) => void;
  /** Called when user clicks the CTA */
  onSubmit?: (tierId: string) => void;
  /** Initially selected tier ID */
  defaultSelectedId?: string;
}

// ---------------------------------------------------------------------------
// SELECTOR VARIANT — Founders Notes style
// ---------------------------------------------------------------------------

function PricingSelector({
  tiers,
  title,
  subtitle,
  ctaText = 'get started',
  onSelect,
  onSubmit,
}: Omit<PricingProps, 'variant'>) {
  return (
    <Container layout="vertical" gap="lg">
      {title && <Text variant="heading-2xl">{title}</Text>}
      {subtitle && <Text variant="body-lg" color="white" leading="relaxed">{subtitle}</Text>}

      <Container layout="horizontal" gap="md" wrap={true}>
        {tiers.map((tier) => (
          <Card
            key={tier.id}
            variant="nested"
            padding="lg"
          >
            <Container layout="vertical" gap="sm" alignItems="center">
              <Text variant="heading" weight="semibold">{tier.title}</Text>
              <Text variant="heading-xl" weight="bold">{tier.price}</Text>
              <Text variant="body" color="muted">{tier.priceSubtext}</Text>
              {tier.subtitle && (
                <Text variant="body" color="muted">{tier.subtitle}</Text>
              )}
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={() => {
                  onSelect?.(tier.id);
                  onSubmit?.(tier.id);
                }}
              >
                {ctaText}
              </Button>
            </Container>
          </Card>
        ))}
      </Container>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// ACCORDION VARIANT — customer style
// ---------------------------------------------------------------------------

function PricingAccordionVariant({
  tiers,
  title,
  subtitle,
  ctaText = 'get access',
  onSelect,
  onSubmit,
}: Omit<PricingProps, 'variant'>) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpanded = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <Container layout="vertical" gap="lg">
      {title && <Text variant="heading-2xl" align="center">{title}</Text>}
      {subtitle && <Text variant="body-lg" color="muted" align="center">{subtitle}</Text>}

      <Container layout="vertical" gap="md">
        {tiers.map((tier) => {
          const isExpanded = expandedId === tier.id;

          return (
            <Card
              key={tier.id}
              variant="nested"
              padding="lg"
              interactive
              onClick={() => toggleExpanded(tier.id)}
            >
              <Container layout="vertical" gap="md">
                {/* Header */}
                <Container layout="horizontal" justifyContent="between" alignItems="center" wrap={true} gap="sm">
                  <Container layout="vertical" gap="xs" flex={1}>
                    <Container layout="horizontal" gap="md" alignItems="center">
                      <Text variant="heading-lg" weight="semibold">{tier.title}</Text>
                      <Text variant="body-lg" color="white">
                        {tier.price} {tier.priceSubtext}
                      </Text>
                    </Container>
                    {tier.subtitle && (
                      <Text variant="body" color="muted">{tier.subtitle}</Text>
                    )}
                  </Container>

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      onSelect?.(tier.id);
                      onSubmit?.(tier.id);
                    }}
                  >
                    {ctaText}
                  </Button>
                </Container>

                {/* Expanded content */}
                {isExpanded && tier.features && tier.features.length > 0 && (
                  <Container layout="vertical" gap="xs" border="top">
                    {tier.features.map((feature, i) => (
                      <Container key={i} layout="horizontal" gap="md" alignItems="start">
                        <Text variant="body" color="muted">•</Text>
                        <Text variant="body" color="white">{feature}</Text>
                      </Container>
                    ))}
                  </Container>
                )}
              </Container>
            </Card>
          );
        })}
      </Container>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT — dispatches to variant
// ---------------------------------------------------------------------------

export function Pricing(props: PricingProps) {
  const { variant, ...rest } = props;

  switch (variant) {
    case 'selector':
      return <PricingSelector {...rest} />;
    case 'accordion':
      return <PricingAccordionVariant {...rest} />;
    default:
      return <PricingSelector {...rest} />;
  }
}
