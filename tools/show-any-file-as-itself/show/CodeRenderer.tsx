// package-set://bitfield-studio/packages/file-content-renderer/show/CodeRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders code files with syntax highlighting via Shiki. Supports optional
// line range selection (startLine/endLine) and displays line numbers in a gutter.
// Uses async Shiki highlighting with sync fallback for immediate render.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Async Shiki with sync fallback — render immediately, enhance with highlighting
// 2. Line numbers rendered in a gutter, starting from startLine (default 1)
// 3. Content sliced by startLine/endLine before highlighting (if provided)
// 4. Scrollable container with optional maxHeight (default 24rem)
// 5. ZERO raw HTML (div/span/p) — all through ui/ components
// 6. ZERO className strings — all through component props
// 7. Monospace font-mono text-xs for code readability
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { Card, Container, Text, CodeBlock } from '../../ui';
import {
  highlightCode,
  highlightCodeSync,
} from './highlight-code-html';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface CodeRendererProps {
  content: string;
  language: string;
  startLine?: number;
  endLine?: number;
  showLineNumbers?: boolean;
  maxHeight?: string;
}


// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function CodeRenderer({
  content,
  language,
  startLine = 1,
  endLine,
  showLineNumbers = true,
  maxHeight = '24rem',
}: CodeRendererProps) {
  // Slice only when an explicit range end is provided. For snippet payloads
  // (e.g. Read tool results with offset), keep content intact and just offset
  // displayed line numbers via startLine.
  const slicedContent = useMemo(() => {
    const lines = content.split('\n');
    if (endLine === undefined) {
      return lines.join('\n');
    }
    const sliceStart = Math.max(0, startLine - 1);
    const sliceEnd = Math.max(sliceStart, endLine);
    const slicedLines = lines.slice(sliceStart, sliceEnd);
    return slicedLines.join('\n');
  }, [content, startLine, endLine]);

  const slicedLines = useMemo(
    () => slicedContent.split('\n'),
    [slicedContent],
  );

  // Async highlight state — sync fallback shown immediately
  const [highlightedHtml, setHighlightedHtml] = useState<string>(
    highlightCodeSync(slicedContent, language),
  );

  useEffect(() => {
    highlightCode(slicedContent, language)
      .then(html => {
        setHighlightedHtml(html);
      })
      .catch(() => {
        setHighlightedHtml(highlightCodeSync(slicedContent, language));
      });
  }, [slicedContent, language]);

  return (
    <Card variant="nested" padding="sm">
      <Container
        layout="horizontal"
        gap="none"
        overflow="auto"
        minWidth="0"
        width="full"
        style={{ maxHeight, fontFamily: 'var(--font-mono)', fontSize: '0.75rem', lineHeight: '1.5' }}
      >
        {showLineNumbers && (
          <Container
            layout="vertical"
            gap="none"
            style={{
              borderRight: '1px solid rgba(255, 255, 255, 0.1)',
              paddingRight: '0.5rem',
              userSelect: 'none',
              textAlign: 'right',
            } as React.CSSProperties}
          >
            {slicedLines.map((_: string, idx: number) => (
              <Text
                key={startLine + idx}
                variant="body-xs"
                color="subtle"
                mono
              >
                {startLine + idx}
              </Text>
            ))}
          </Container>
        )}
        <CodeBlock html={highlightedHtml} />
      </Container>
    </Card>
  );
}
