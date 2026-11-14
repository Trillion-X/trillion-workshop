// packages/current-summary/show/SummaryGrid.tsx
//
// Browser-local grid wrapper for current-summary reply cards.

import type { ReactNode } from 'react';

export function SummaryGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {children}
    </div>
  );
}
