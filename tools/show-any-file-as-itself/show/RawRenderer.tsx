// package-set://bitfield-studio/packages/file-content-renderer/show/RawRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Fallback renderer for unknown file types. Displays raw text in monospace
// with whitespace preservation. No syntax highlighting — just plain content
// in a scrollable container.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Simple monospace display using ui/ Text component
// 2. Whitespace preserved via whitespace-pre-wrap
// 3. Optional maxHeight for scrollable containers
// 4. Empty file state: show faint "(empty file)" message
// 5. Wrapped in Card with nested styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Card, Container, Text } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface RawRendererProps {
  content: string;
  maxHeight?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function RawRenderer({
  content,
  maxHeight = '24rem',
}: RawRendererProps) {
  if (!content || content.trim().length === 0) {
    return (
      <Card variant="nested" padding="sm">
        <Text variant="body-xs" color="faint">
          (empty file)
        </Text>
      </Card>
    );
  }

  return (
    // minWidth=0 + width=full: scroll long content inside this box rather than
    // letting it widen the preview past the viewport.
    <Container overflow="auto" minWidth="0" width="full" style={{ maxHeight }}>
      <Card variant="nested" padding="sm">
        <Text variant="body-xs" mono color="subtle" wrap="preserve">
          {content}
        </Text>
      </Card>
    </Container>
  );
}
