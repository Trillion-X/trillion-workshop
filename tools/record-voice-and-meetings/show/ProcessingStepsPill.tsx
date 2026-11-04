// parts/record-audio/show/ProcessingStepsPill.tsx
//
// PURPOSE
//   The pill on a recording's note while it is being processed: Upload, Transcript, Summary (Amie's three-step pill). The
//   stages and their states come from read-data/processing-steps.ts and the words from recording-widgets.json; the pill
//   itself is the shared StepPill (parts/ui/show/step-pill), so its look is every stage list's look.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It draws nothing when no stage is being worked on.
//   2. It keeps and reads nothing: a stage's state maps to the shared mark (waiting: empty ring, working: breathing ring,
//      done: tick).

import * as React from 'react';
import { StepPill, type StepPillStage } from '../../ui/show/step-pill';
import widgets from '../read-data/recording-widgets.json';
import { processingNow, type Step, type StepState } from '../read-data/processing-steps';

const MARKS: Record<StepState, StepPillStage['state']> = { done: 'done', working: 'checking', waiting: 'todo' };

export function ProcessingStepsPill({ steps }: { steps: readonly Step[] }) {
  if (!processingNow(steps)) return null;
  return <StepPill label={widgets.steps.label} stages={steps.map(step => ({
    id: step.id, label: step.label, state: MARKS[step.state], said: widgets.steps.states[step.state],
  }))} />;
}
