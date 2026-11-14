// packages/ui/diff-view/diff-logic.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure unified-diff computation for UI surfaces that need line-level before/after
// rendering. This sits with the reusable DiffView primitive so feature packages
// do not import diff logic from each other.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. computeUnifiedDiff is pure and has no side effects.
// 2. Returns DiffLine[] where type is 'added' | 'removed' | 'unchanged'.
// 3. Unchanged lines have both oldLineNumber and newLineNumber.
// 4. Added lines have only newLineNumber, removed lines have only oldLineNumber.
// 5. Line numbers start at 1 and increment continuously per side.
// 6. Content is split on actual line boundaries with no trailing newline.
//
// =============================================================================

import { diffLines } from 'diff';

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export function computeUnifiedDiff(before: string, after: string): DiffLine[] {
  const changes = diffLines(before, after);
  const lines: DiffLine[] = [];

  let oldLine = 1;
  let newLine = 1;

  for (const change of changes) {
    const text = change.value.replace(/\n$/, '');
    const subLines = text.split('\n');

    for (const subLine of subLines) {
      if (change.added) {
        lines.push({
          type: 'added',
          content: subLine,
          newLineNumber: newLine,
        });
        newLine++;
      } else if (change.removed) {
        lines.push({
          type: 'removed',
          content: subLine,
          oldLineNumber: oldLine,
        });
        oldLine++;
      } else {
        lines.push({
          type: 'unchanged',
          content: subLine,
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine++;
        newLine++;
      }
    }
  }

  return lines;
}
