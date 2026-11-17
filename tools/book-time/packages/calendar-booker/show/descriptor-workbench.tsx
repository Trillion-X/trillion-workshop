// packages/calendar-booker/show/descriptor-workbench.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Vocabulary-free presentation chrome shared by every calendar-booker surface.
// It renders the three render-state phases — `loading`, `error`, `ready` — over
// an already-translated `ViewDescriptor[]` tree and the capability map, and
// nothing else. It owns NO product words: every human string it prints arrives
// as data (`notice`) or inside the descriptor tree the feed produced (L098).
// It exists so the owner surface and the setup surface (and U3's guest surfaces)
// never re-hand-roll loading/error wrappers (DRY / L069).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO product/domain vocabulary. The only literal strings here are generic
//    host-chrome a11y labels (`Loading`), identical in spirit to an
//    ErrorBoundary. All booking words come from `views`/`notice` (the feed).
// 2. The `ready` phase delegates entirely to the blind `DescriptorSurface` —
//    this file never inspects a `render_kind`, never branches on a node shape.
// 3. No state, no data fetch, no dispatch logic. It forwards `onAction` /
//    `onValueChange` straight through to the renderer.
//
// =============================================================================

import * as React from 'react';
import { Container, Spinner, Text } from '../../../../ui';
import { DescriptorSurface } from './descriptor-surface';
import type { RenderCapabilityMap } from './render-capability-map';
import type { ActionDescriptor, ViewDescriptor } from './view-descriptor';

export type DescriptorWorkbenchPhase = 'loading' | 'ready' | 'error';

export interface DescriptorWorkbenchProps {
  /** Already-translated descriptor trees (one or more surface roots). */
  views: ViewDescriptor[];
  /** The leaf binding pack the blind renderer dispatches through. */
  caps: RenderCapabilityMap;
  /** Which render-state phase to show. Defaults to `ready`. */
  phase?: DescriptorWorkbenchPhase;
  /** An already-human message (loading hint or error reason). Never invented here. */
  notice?: string;
  onAction?: (action: ActionDescriptor, node: ViewDescriptor) => void;
  onValueChange?: (node: ViewDescriptor, value: unknown) => void;
}

export function DescriptorWorkbench(props: DescriptorWorkbenchProps): React.ReactElement {
  const phase = props.phase ?? 'ready';

  if (phase === 'loading') {
    return (
      <Container layout="vertical" gap="md" padding="lg" alignItems="center">
        <Spinner aria-label="Loading" />
        {props.notice ? (
          <Text variant="caption" color="muted">
            {props.notice}
          </Text>
        ) : null}
      </Container>
    );
  }

  if (phase === 'error') {
    return (
      <Container layout="vertical" gap="sm" padding="lg">
        <Text variant="body" color="strong">
          {props.notice ?? ''}
        </Text>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="lg" padding="lg">
      {props.views.map((node) => (
        <DescriptorSurface
          key={node.id}
          node={node}
          caps={props.caps}
          onAction={props.onAction}
          onValueChange={props.onValueChange}
        />
      ))}
      {props.notice ? (
        <Text variant="caption" color="muted">
          {props.notice}
        </Text>
      ) : null}
    </Container>
  );
}

export default DescriptorWorkbench;
