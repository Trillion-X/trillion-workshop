// packages/guided-overlay/show/default-progress-visuals.tsx
//
// The DEFAULT progress visuals guided-overlay ships for the common
// `progress_style.style` values (counter | dots | bar | segmented). Registered
// INTO the blind `StepProgressRegistry` — the surface never branches on `style`.
// A new visual (e.g. a ring) is one `register()` + zero surface change (L069).
//
// All four derive from the SAME `ProgressState` / `segmentFills`, so the counter,
// dots, bar, and segments can never disagree. Composed from shared `ui` primitives
// (Text/Container/ProgressBar/ColorDot) — no raw HTML (L065).

import type { ReactElement } from 'react';
import { Text } from '../../ui/show/text/Text';
import { Container } from '../../ui/show/container/container';
import { ProgressBar } from '../../ui/show/progress-bar/ProgressBar';
import { ColorDot } from '../../ui/show/color-dot/ColorDot';
import { segmentFills } from '../../ui/show/step-progress/step-progress';
import {
  type StepProgressComponent,
  type StepProgressProps,
} from '../../ui/show/step-progress/StepProgress';
import type { StepProgressRegistry } from '../../ui/show/step-progress/step-progress';

const FILLED = 'var(--accent-purple)';
const EMPTY = 'var(--text-ghost, var(--glass-bg-subtle))';

/** "3 / 7" — the plain counter. */
function CounterVisual({ state }: StepProgressProps): ReactElement {
  return (
    <Text variant="label" color="muted">
      {state.current} / {state.total}
    </Text>
  );
}

/** A row of dots, filled up to the cursor. */
function DotsVisual({ state }: StepProgressProps): ReactElement {
  const fills = segmentFills(state);
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      {fills.map((on, i) => (
        <ColorDot key={i} size="sm" color={on ? FILLED : EMPTY} />
      ))}
    </Container>
  );
}

/** A continuous bar filled to the completion ratio. */
function BarVisual({ state }: StepProgressProps): ReactElement {
  return <ProgressBar percentage={state.ratio * 100} color={FILLED} />;
}

/** A row of equal segments, each fully on/off up to the cursor. */
function SegmentedVisual({ state }: StepProgressProps): ReactElement {
  const fills = segmentFills(state);
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" style={{ width: '100%' }}>
      {fills.map((on, i) => (
        <Container key={i} layout="vertical" style={{ flexGrow: 1, flexBasis: 0 }}>
          <ProgressBar percentage={on ? 100 : 0} color={FILLED} />
        </Container>
      ))}
    </Container>
  );
}

/** The fallback for a `style` nobody registered (L083) — the counter always reads. */
export const FallbackProgress: StepProgressComponent = CounterVisual;

/** Register the default progress visuals into a registry. Returns the registry. */
export function registerDefaultProgressVisuals(
  registry: StepProgressRegistry<StepProgressComponent>,
): StepProgressRegistry<StepProgressComponent> {
  registry.register('counter', CounterVisual);
  registry.register('dots', DotsVisual);
  registry.register('bar', BarVisual);
  registry.register('segmented', SegmentedVisual);
  return registry;
}
