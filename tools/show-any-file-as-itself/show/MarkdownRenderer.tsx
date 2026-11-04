// package-set://bitfield-studio/packages/file-content-renderer/show/MarkdownRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders markdown content with syntax-highlighted code blocks via Shiki.
// Uses sync-first + async-replace pattern: immediate render with basic markdown,
// then enhanced with Shiki highlighting as it loads asynchronously.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Immediate render with parseMarkdown (sync, no blocking)
// 2. Async Shiki enhancement via parseMarkdownAsync
// 3. Memoized to prevent unnecessary re-renders on stable content
// 4. Optional maxHeight for scrollable containers
// 5. prose-content class applies markdown styling (from global.css @layer)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState, memo } from 'react';
import { Card, Container, MarkdownBlock } from '../../ui';
import {
  parseMarkdown,
  parseMarkdownAsync,
} from './render-markdown-html';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface MarkdownRendererProps {
  content: string;
  maxHeight?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  maxHeight,
}: MarkdownRendererProps) {
  // Immediate render: sync markdown without highlighting
  const [html, setHtml] = useState(() => parseMarkdown(content));

  // Load Shiki and highlight on mount (or when content changes)
  useEffect(() => {
    // Async IIFE: load Shiki and replace HTML with highlighted version
    (async () => {
      try {
        const highlighted = await parseMarkdownAsync(content);
        setHtml(highlighted);
      } catch (err) {
        // If async highlighting fails, keep the sync version
        console.error('[MarkdownRenderer] parseMarkdownAsync failed:', err);
      }
    })();
  }, [content]);

  return (
    <Container
      overflow={maxHeight ? 'auto' : 'visible'}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <Card variant="nested" padding="sm">
        <MarkdownBlock html={html} />
      </Card>
    </Container>
  );
});

export default MarkdownRenderer;
