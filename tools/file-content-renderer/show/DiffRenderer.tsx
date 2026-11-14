// package-set://bitfield-studio/packages/file-content-renderer/show/DiffRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders unified diffs with side-by-side line numbers and color-coded changes.
// Wraps the DiffView ui/ component for file-viewer integration. Computes diff
// lines from before/after strings and displays with optional stats header.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Compute diff via computeUnifiedDiff(oldString, newString)
// 2. Display stats header: +{added} -{removed} lines using Badge components
// 3. If no changes: show empty state with faint text
// 4. Otherwise: render DiffView with maxHeight constraint
// 5. All styling through ui/ components (DiffView, Card, Badge, Text)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useMemo } from 'react';
import { Card, DiffView, Badge, Text, Container, computeUnifiedDiff } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface DiffRendererProps {
  diff: {
    oldString: string;
    newString: string;
  };
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function DiffRenderer({
  diff,
  maxHeight = 384,
}: DiffRendererProps) {
  // Compute diff lines and stats
  const { lines, addedCount, removedCount } = useMemo(() => {
    const diffLines = computeUnifiedDiff(diff.oldString, diff.newString);
    const added = diffLines.filter(l => l.type === 'added').length;
    const removed = diffLines.filter(l => l.type === 'removed').length;
    return { lines: diffLines, addedCount: added, removedCount: removed };
  }, [diff.oldString, diff.newString]);

  // If no changes, show empty state
  if (lines.length === 0) {
    return (
      <Card variant="nested" padding="sm">
        <Text variant="body-xs" color="faint">
          (no changes)
        </Text>
      </Card>
    );
  }

  return (
    <Container layout="vertical" gap="sm">
      {/* Stats header */}
      <Container layout="horizontal" gap="sm">
        {addedCount > 0 && (
          <Badge variant="success">
            +{addedCount}
          </Badge>
        )}
        {removedCount > 0 && (
          <Badge variant="destructive">
            -{removedCount}
          </Badge>
        )}
      </Container>

      {/* Diff viewer */}
      <DiffView lines={lines} maxHeight={maxHeight} />
    </Container>
  );
}
