// bitfield-studio/frontends/web/src/packages/ui/empty-placeholder/EmptyPlaceholder.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic empty state placeholder — displays an icon and message when a view
// has no content to display. Replaces scattered <div> empty state blocks
// throughout the app with a consistent, composable UI component.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No raw HTML elements or className — uses Container, Icon, Text only
// 2. Icon prop accepts any lucide-react icon type
// 3. Message text rendered via Text component with faint color
// 4. Consistent spacing (py-12 vertical padding via props)
// 5. Centered layout (flex column, center alignment)
//
// =============================================================================

import React from 'react';
import type { LucideProps } from 'lucide-react';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface EmptyPlaceholderProps {
  icon: React.ElementType<LucideProps>;
  message: string;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  fill?: boolean;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function EmptyPlaceholder({
  icon,
  message,
  title,
  description,
  actions,
  children,
  fill = true,
}: EmptyPlaceholderProps) {
  return (
    <Container
      layout="vertical"
      alignItems="center"
      justifyContent="center"
      gap="md"
      padding="lg"
      flex={fill ? 1 : undefined}
    >
      <Icon icon={icon} size="xl" color="faint" />
      {title ? (
        <Text variant="heading-lg" color="strong">
          {title}
        </Text>
      ) : null}
      <Text variant="body" color="faint">
        {message}
      </Text>
      {description ? (
        <Text variant="body-sm" color="muted">
          {description}
        </Text>
      ) : null}
      {actions ? (
        <Container
          layout="horizontal"
          alignItems="center"
          justifyContent="center"
          gap="sm"
          padding="none"
        >
          {actions}
        </Container>
      ) : null}
      {children}
    </Container>
  );
}
