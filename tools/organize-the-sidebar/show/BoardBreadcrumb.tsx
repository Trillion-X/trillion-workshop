// packages/group/show/BoardBreadcrumb.tsx
// The drilled-into-a-section breadcrumb row: board root + one crumb per nav level.

import React from 'react';
import { Button, Container, Icon, Text } from '../../ui';
import { ChevronRight, Home } from 'lucide-react';

export interface BoardBreadcrumbProps {
  boardTitle: string;
  /** One label per drilled level, root-first. Empty → the caller hides the row. */
  crumbs: readonly string[];
  /** Navigate to a depth: 0 = board root, i+1 = the i-th crumb. */
  onNavTo: (depth: number) => void;
}

export function BoardBreadcrumb({ boardTitle, crumbs, onNavTo }: BoardBreadcrumbProps) {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" padding="sm" wrap>
      <Button variant="ghost" size="sm" onClick={() => onNavTo(0)} aria-label="Back to board root">
        <Icon icon={Home} size="sm" /> {boardTitle}
      </Button>
      {crumbs.map((label, i) => (
        <Container key={`${label}-${i}`} layout="horizontal" gap="xs" alignItems="center">
          <Icon icon={ChevronRight} size="sm" color="muted" />
          {i === crumbs.length - 1 ? (
            <Text variant="body-sm">{label}</Text>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => onNavTo(i + 1)}>{label}</Button>
          )}
        </Container>
      ))}
    </Container>
  );
}
