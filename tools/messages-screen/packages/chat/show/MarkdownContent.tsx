// bitfield-studio/frontends/web/src/packages/chat/show/MarkdownContent.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// React component that renders markdown content with syntax-highlighted code
// blocks. Uses a sync-first + async-replace pattern:
//
// 1. Immediately renders sync markdown (parseMarkdown) — no flash of empty
// 2. In useEffect, loads Shiki and re-renders with highlighted code blocks
// 3. Memoizes per content string to avoid re-highlighting identical content
//
// This provides the UX of instant content appearance plus gradual enhancement
// with pretty syntax highlighting as Shiki loads.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Renders sync fallback immediately (no loading state, no flash)
// 2. Swaps to async version after Shiki loads via useState + useEffect
// 3. Memoization prevents re-highlighting the same content string
// 4. HTML rendering via dangerouslySetInnerHTML (already escaped in parseMarkdown/parseMarkdownAsync)
// 5. Component is memoized to prevent unnecessary re-renders
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState, memo, useMemo } from 'react';
import { parseMarkdown, parseMarkdownAsync } from '@/packages/chat/show/chat-logic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface MarkdownContentProps {
  /** Markdown string to render (with optional fenced code blocks) */
  content: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Renders markdown content with async syntax highlighting.
 *
 * **Rendering flow:**
 * 1. Mount: Renders sync markdown (parseMarkdown) immediately
 * 2. useEffect: Loads Shiki and calls parseMarkdownAsync
 * 3. State update: Swaps innerHTML to highlighted version
 *
 * **Memoization:** The content string is memoized via useMemo. If the parent
 * passes the same content string reference, the component does not re-highlight.
 * If content is an inline string literal, memoization won't prevent re-renders
 * (parent responsibility to memoize message content).
 *
 * **Key Props:**
 * - `content`: Markdown string. Must be stable (same reference) to benefit from memoization
 *
 * **Rendered output:**
 * - Same className and structure as the original dangerouslySetInnerHTML approach
 * - Inherits prose-content styles from parent or global CSS
 */
const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  // Immediate render: sync markdown without highlighting
  const [html, setHtml] = useState(() => parseMarkdown(content));

  // Store the current content in a ref-like variable to avoid stale closures in async handler
  const memoizedContent = useMemo(() => content, [content]);

  // Load Shiki and highlight on mount (or when content changes)
  useEffect(() => {
    let cancelled = false;
    setHtml(parseMarkdown(memoizedContent));

    // Async IIFE: load Shiki and replace HTML with highlighted version
    (async () => {
      try {
        const highlighted = await parseMarkdownAsync(memoizedContent);
        if (cancelled) return;
        setHtml(highlighted);
      } catch (err) {
        if (cancelled) return;
        // If async highlighting fails, keep the sync version
        console.error('[MarkdownContent] parseMarkdownAsync failed:', err);
        // html is already set to sync parseMarkdown, so no need to reset
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memoizedContent]);

  return (
    <div
      className="min-w-0 w-full max-w-full break-words prose-content text-[var(--text-strong)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default MarkdownContent;
