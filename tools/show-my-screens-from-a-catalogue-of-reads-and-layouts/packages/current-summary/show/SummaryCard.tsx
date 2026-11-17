// packages/current-summary/show/SummaryCard.tsx
//
// Browser-local compact card wrapper for current-summary replies.

import { Card } from '../../../../ui';
import type { ReactNode } from 'react';

export function SummaryCard({ children }: { children: ReactNode }) {
  return (
    <Card variant="surface" padding="md">
      {children}
    </Card>
  );
}
