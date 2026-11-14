// packages/ask-questions-sort-answers-follow-up/show/BuilderView.tsx
//
// Entry View for the builder: reads the live question-type-capability registry
// from published-records and renders the BuilderSurface. Thin glue — all editing
// is builder-model, all rendering is BuilderSurface + FillSurface preview.

import React from 'react';
import { useBitfieldData } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react';
import { BuilderSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/BuilderSurface';
import { readCapabilityRegistry } from '@/packages/ask-questions-sort-answers-follow-up/read-data/read-forms-data';

export function BuilderView() {
  const published = useBitfieldData('published-records');
  const registry = React.useMemo(() => readCapabilityRegistry(published), [published]);
  return <BuilderSurface registry={registry} />;
}
