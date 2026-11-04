// PORTED FROM: bitfield-packages/packages/chat/show/ToolRendererDiff.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/ToolRendererDiff.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders Edit and Write tool results. Extracts old_string/new_string from
// params and displays them as before/after blocks with visual diff styling
// (red for removed, green for added) via the DiffView ui/ component.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Edit tool: shows old_string (red) and new_string (green) via DiffView
// 2. Write tool: shows all content lines as "added" (new content)
// 3. Text extraction is safe — missing keys show empty strings
// 4. Scrollable for large diffs — DiffView handles maxHeight
// 5. ZERO raw HTML (div/span/p) — all through ui/ components
// 6. ZERO className strings — all through component props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { ToolUseInfo } from '../read-data/chat-message-types';
import { ChatFileContent } from './ChatFileContent';
import { Badge, Container, DiffView, Text, type DiffLine } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ToolRendererDiffProps {
  toolUse: ToolUseInfo;
}

function readPatchText(params: Record<string, unknown>): string | null {
  for (const key of ['patch', 'diff', 'input', 'raw']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function parsePatchText(patchText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const rawLine of patchText.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      lines.push({ type: 'added', content: rawLine.slice(1), newLineNumber: newLine });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      lines.push({ type: 'removed', content: rawLine.slice(1), oldLineNumber: oldLine });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(' ')) {
      lines.push({
        type: 'unchanged',
        content: rawLine.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    lines.push({ type: 'unchanged', content: rawLine });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ToolRendererDiff({ toolUse }: ToolRendererDiffProps) {
  const filePath = String(
    toolUse.params.file_path
    ?? toolUse.params.path
    ?? toolUse.params.filePath
    ?? '',
  );

  if (toolUse.tool === 'Edit') {
    const oldString = String(toolUse.params.old_string ?? '');
    const newString = String(toolUse.params.new_string ?? '');
    return (
      <ChatFileContent
        filePath={filePath}
        diff={{ oldString, newString }}
        maxHeight="24rem"
        showHeader={!!filePath}
      />
    );
  }

  if (toolUse.tool === 'Write') {
    const content = String(toolUse.params.content ?? '');
    return (
      <ChatFileContent
        filePath={filePath}
        diff={{ oldString: '', newString: content }}
        maxHeight="24rem"
        showHeader={!!filePath}
      />
    );
  }

  const patchText = readPatchText(toolUse.params);
  if (patchText) {
    const lines = parsePatchText(patchText);
    const addedCount = lines.filter((line) => line.type === 'added').length;
    const removedCount = lines.filter((line) => line.type === 'removed').length;
    return (
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm">
          {addedCount > 0 && <Badge variant="success">+{addedCount}</Badge>}
          {removedCount > 0 && <Badge variant="destructive">-{removedCount}</Badge>}
          {addedCount === 0 && removedCount === 0 && (
            <Text variant="body-xs" color="faint">
              (no changed lines)
            </Text>
          )}
        </Container>
        <DiffView lines={lines} maxHeight={384} />
      </Container>
    );
  }

  // Fallback for other tools
  return (
    <ChatFileContent
      filePath={filePath}
      content={String(toolUse.result ?? '')}
    />
  );
}
