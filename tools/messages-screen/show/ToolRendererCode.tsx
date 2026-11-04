// PORTED FROM: bitfield-packages/packages/chat/show/ToolRendererCode.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/ToolRendererCode.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders Read and Glob tool results. Displays file path as header followed
// by the result content in a syntax-highlighted code block. Uses glass-nested
// Card with async Shiki syntax highlighting.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. File path extracted from params.file_path shown in header
// 2. Result content displayed with overflow scrolling
// 3. Async Shiki highlighting — sync fallback on first render
// 4. ZERO raw HTML (div/span/p) — all through ui/ components
// 5. ZERO className strings — all through component props
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

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ToolRendererCodeProps {
  toolUse: ToolUseInfo;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ToolRendererCode({ toolUse }: ToolRendererCodeProps) {
  const filePath = String(
    toolUse.params.file_path
    ?? toolUse.params.path
    ?? toolUse.params.filePath
    ?? '',
  );
  const result = String(toolUse.result ?? '');
  const startLineRaw = toolUse.params.offset
    ?? toolUse.params.start_line
    ?? toolUse.params.startLine;
  const startLine = startLineRaw !== undefined ? Number(startLineRaw) : undefined;

  return (
    <ChatFileContent
      filePath={filePath}
      content={result}
      startLine={startLine}
      maxHeight="12rem"
      showHeader={!!filePath}
      showActions={!!filePath}
    />
  );
}
