// parts/ui/show/breadcrumb/mount-breadcrumb.tsx
//
// PURPOSE
//   A path of places above the one on screen (folders, sections), drawn with the Coss breadcrumb. Each step before
//   the last opens its place; the last is where the person is. A host passes steps as DATA and hears which one opened.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Steps are DATA: {id, label}. Nothing here knows what a step is.
//   2. The root renders outside the caller's React commit and unmounts on a microtask, so a caller inside another
//      shared surface's render can mount and tear this down safely.

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '../coss/ui/breadcrumb';

export type BreadcrumbStep = { id: string; label: string };

/** The steps as a React element, for a host drawing inside its own tree. */
export function BreadcrumbSteps({ steps, onOpen }: { steps: BreadcrumbStep[]; onOpen: (id: string) => void }) {
  return (
    <Breadcrumb className="coss-ui">
      <BreadcrumbList>
        {steps.map((step, index) => (
          <React.Fragment key={step.id}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {index === steps.length - 1
                ? <BreadcrumbPage>{step.label}</BreadcrumbPage>
                : <BreadcrumbLink onClick={() => onOpen(step.id)}>{step.label}</BreadcrumbLink>}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function mountBreadcrumb(host: HTMLElement, options: { steps: BreadcrumbStep[]; onOpen: (id: string) => void }): () => void {
  const root = createRoot(host);
  root.render(<BreadcrumbSteps steps={options.steps} onOpen={options.onOpen} />);
  return () => queueMicrotask(() => root.unmount());
}
