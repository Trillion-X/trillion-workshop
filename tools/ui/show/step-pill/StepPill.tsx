// parts/ui/show/step-pill/StepPill.tsx
//
// PURPOSE
//   A small pill of named stages in order, each with its mark: an empty ring while it waits, a breathing ring while it is
//   worked on, the round tick once done (a recording's Upload, Transcript, Summary; any run of stages a screen reports).
//   Marks are the shared step mark, so the pill upgrades with it in every look.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Presentational: the stages, their states and every word (the pill's name, each state said to a screen reader) are
//      the caller's.
//   2. It draws nothing when it has no stages.
//   3. Marks come only from the shared StepMark; the pill draws no circle, tick or colour of its own.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import { StepMark, type StepMarkState } from '../step-mark';

export type StepPillStage = { id: string; label: string; state: StepMarkState; /** Said to a screen reader after the label. */ said?: string };

export function StepPill({ stages, label }: { stages: readonly StepPillStage[]; label: string }) {
  if (!stages.length) return null;
  return (
    <Container layout="horizontal" gap="md" alignItems="center" rounded="lg" border="all" background="secondary" padding="sm"
      role="status" aria-label={label} data-step-pill="">
      {stages.map(stage => (
        <Container key={stage.id} layout="horizontal" gap="xs" alignItems="center" data-step={stage.id} data-state={stage.state}
          aria-label={stage.said ? `${stage.label}: ${stage.said}` : stage.label}>
          <StepMark state={stage.state} />
          <Text as="span" variant="body-xs" color={stage.state === 'todo' ? 'subtle' : 'strong'}>{stage.label}</Text>
        </Container>
      ))}
    </Container>
  );
}
