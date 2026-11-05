// packages/group/show/BoardStatusOverlay.tsx
// The canvas status overlay: error + retry, loading line, or the empty-board hint. Null when idle.

import React from 'react';
import { Button, Container, Icon, Text } from '../../ui/index.ts';
import { Sparkles } from 'lucide-react';

export interface BoardStatusOverlayProps {
  isLoading: boolean;
  empty: boolean;
  /** Human-language load failure (never raw error text — L114/L118). Takes
   *  priority over both loading and empty so a hung/failed load never renders
   *  as a false "Your board is empty" once `isLoading` flips back to false. */
  error?: string | null;
  /** Re-runs the load — offered only when `error` is set. */
  onRetry?: () => void;
}

/** Call as a plain function: returns null when no state applies, so the
 *  CanvasViewport's `{overlay ? … : null}` gate renders no wrapper at all. */
export function BoardStatusOverlay({ isLoading, empty, error, onRetry }: BoardStatusOverlayProps): React.ReactElement | null {
  if (error) {
    return (
      <Container layout="vertical" gap="sm" alignItems="center">
        <Text variant="heading-xs">{error}</Text>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry} data-board-status-retry>
            Try again
          </Button>
        ) : null}
      </Container>
    );
  }
  if (isLoading) return <Text variant="body-sm" color="muted">Loading your board…</Text>;
  if (empty) {
    return (
      <Container layout="vertical" gap="sm" alignItems="center">
        <Icon icon={Sparkles} size="lg" color="accent" />
        <Text variant="heading-xs">Your board is empty</Text>
        <Text variant="body-xs" color="muted">Use the toolbar to drop your first image or note, then drag to arrange.</Text>
      </Container>
    );
  }
  return null;
}
