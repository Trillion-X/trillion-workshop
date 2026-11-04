// PORTED FROM: bitfield-packages/packages/chat/show/ToolRendererSearch.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/ToolRendererSearch.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders Grep and search tool results. Parses result text to identify file
// paths and matching lines, then displays them with a file-path header
// followed by the matching lines. Includes line-number gutter for context.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. File path headers recognized by common search tools (e.g., "file.ts:")
// 2. Matching lines grouped under their source file
// 3. Line number gutter for each match
// 4. Scrollable for large result sets — max-h-48 with overflow-y-auto
// 5. Pure text parsing — no regex engine deps
// 6. ZERO raw HTML (div/span/p) — all through ui/ components
// 7. ZERO className strings — all through component props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { ToolUseInfo } from '../read-data/chat-message-types';
import { Card, Text, Container } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ToolRendererSearchProps {
  toolUse: ToolUseInfo;
}

interface SearchResult {
  file: string;
  lines: Array<{ lineNum: number; content: string }>;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Parse grep-style output into file-grouped results.
 * Lines format: "file.ts:123: content" or "file.ts-123- content"
 */
function parseSearchResults(output: string): SearchResult[] {
  const fileMap: Map<string, Array<{ lineNum: number; content: string }>> = new Map();
  let fallbackCounter = 0;
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    // Try to match "file:line: content" or "file-line- content"
    const match = line.match(/^(.+?)(?::|-)(\d+)(?::|-)(.*)$/);
    if (match) {
      const [, file, lineNumStr, content] = match;
      if (!fileMap.has(file)) {
        fileMap.set(file, []);
      }
      fileMap.get(file)!.push({ lineNum: parseInt(lineNumStr, 10), content: content.trim() });
    } else {
      // Fallback: ungrouped line
      const key = '(results)';
      if (!fileMap.has(key)) {
        fileMap.set(key, []);
      }
      fileMap.get(key)!.push({ lineNum: ++fallbackCounter, content: line.trim() });
    }
  }

  return Array.from(fileMap.entries()).map(([file, lines]) => ({ file, lines }));
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ToolRendererSearch({ toolUse }: ToolRendererSearchProps) {
  const result = String(toolUse.result ?? '');

  if (!result.trim()) {
    return (
      <Card variant="nested" padding="sm">
        <Text variant="body-xs" color="faint">
          (no matches)
        </Text>
      </Card>
    );
  }

  const results = parseSearchResults(result);

  return (
    <Container layout="vertical" gap="sm" overflow="y-auto">
      {results.map((searchResult, idx) => (
        <Container key={idx} layout="vertical" gap="xs">
          {/* File path header */}
          <Text variant="label" color="success">
            {searchResult.file}
          </Text>

          {/* Matching lines */}
          <Card variant="nested" padding="sm">
            <Container layout="vertical" gap="none">
              {searchResult.lines.map((entry) => (
                <Container key={entry.lineNum} layout="horizontal" gap="sm">
                  <Text variant="caption" color="ghost" mono tabular>
                    {entry.lineNum}
                  </Text>
                  <Text variant="body-xs" color="subtle" mono wrap="preserve">
                    {entry.content}
                  </Text>
                </Container>
              ))}
            </Container>
          </Card>
        </Container>
      ))}
    </Container>
  );
}
