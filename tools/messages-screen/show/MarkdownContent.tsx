// PORTED FROM: bitfield-packages/packages/chat/show/MarkdownContent.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/show/MarkdownContent.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// React component that renders markdown content with syntax-highlighted code
// blocks. Uses a sync-first + async-replace pattern:
//
// 1. Immediately renders sync markdown (markdownTokens) — no flash of empty
// 2. In useEffect, loads Shiki and re-renders with highlighted code blocks
// 3. Memoizes per content string to avoid re-highlighting identical content
//
// Trillion: the words are drawn as React elements by the shared MarkdownNodes
// (parts/ui/show/markdown-block), and Shiki's colours arrive as tokens
// (codeToTokens) rather than an HTML string, because application code in
// Trillion never assigns HTML (the no-inline-html guard). Listed in
// scripts/port-sources.json.
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
// 4. No HTML string: tokens become React elements (MarkdownNodes); raw HTML in the source shows as its words
// 5. Component is memoized to prevent unnecessary re-renders
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState, memo, useMemo } from 'react';
import { MarkdownNodes, type HighlightedLine } from '../../ui/show/markdown-block/MarkdownNodes';
import { RecordChip, mentionRuns, type KeptMention } from '../../ui/show/record-chip';
import { markdownTokens } from './chat-logic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface MarkdownContentProps {
  /** Markdown string to render (with optional fenced code blocks) */
  content: string;
  /** Trillion: what the words name, each drawn as its live record chip where its `@label` is written. */
  mentions?: readonly KeptMention[];
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

type Highlighted = ReadonlyMap<string, readonly HighlightedLine[]>;
const codeKey = (code: string, lang: string) => `${lang}\u0000${code}`;

/**
 * Renders markdown content with async syntax highlighting.
 *
 * **Rendering flow:**
 * 1. Mount: Renders the markdown tokens immediately, code blocks plain
 * 2. useEffect: Loads Shiki and tokenizes each fenced code block
 * 3. State update: Swaps each code block to its coloured tokens
 *
 * **Memoization:** The content string is memoized via useMemo. If the parent
 * passes the same content string reference, the component does not re-highlight.
 *
 * **Key Props:**
 * - `content`: Markdown string. Must be stable (same reference) to benefit from memoization
 */
const MarkdownContent = memo(function MarkdownContent({ content, mentions }: MarkdownContentProps) {
  // Immediate render: markdown tokens without highlighting
  const tokens = useMemo(() => markdownTokens(content), [content]);
  const [highlighted, setHighlighted] = useState<Highlighted>(() => new Map());

  // Load Shiki and highlight on mount (or when content changes)
  useEffect(() => {
    let cancelled = false;
    setHighlighted(new Map());
    const blocks: { text: string; lang: string }[] = [];
    const collect = (list: readonly { type: string; [key: string]: unknown }[]) => {
      for (const token of list) {
        if (token.type === 'code') blocks.push({ text: String(token.text ?? ''), lang: String(token.lang ?? '') });
        if (Array.isArray(token.tokens)) collect(token.tokens as never);
        if (Array.isArray(token.items)) collect(token.items as never);
      }
    };
    collect(tokens as never);
    if (!blocks.length) return;

    // Async IIFE: load Shiki and replace each code block with its coloured tokens
    (async () => {
      try {
        const { getHighlighter } = await import('./shiki-loader');
        const hl = await getHighlighter();
        const next = new Map<string, readonly HighlightedLine[]>();
        for (const block of blocks) {
          const targetLang = block.lang.trim() || 'text';
          if (!hl.getLoadedLanguages().includes(targetLang as never)) {
            try { await hl.loadLanguage(targetLang as never); } catch { /* unknown language: plain text */ }
          }
          const lang = hl.getLoadedLanguages().includes(targetLang as never) ? targetLang : 'text';
          const result = hl.codeToTokens(block.text, {
            lang: lang as never,
            themes: { light: 'github-light-default', dark: 'github-dark-default' },
            defaultColor: false,
          });
          next.set(codeKey(block.text, block.lang), result.tokens.map(line => line.map(token => ({
            content: token.content,
            style: token.htmlStyle as Record<string, string> | undefined,
          }))));
        }
        if (cancelled) return;
        setHighlighted(next);
      } catch (err) {
        if (cancelled) return;
        // If async highlighting fails, keep the plain code blocks
        console.error('[MarkdownContent] highlighting failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tokens]);

  const highlight = useMemo(
    () => (code: string, lang: string) => highlighted.get(codeKey(code, lang)) ?? null,
    [highlighted],
  );

  const renderText = useMemo(() => (mentions?.length
    ? (text: string, key: string) => mentionRuns(text, mentions).map((run, index) => (run.type === 'text'
      ? <React.Fragment key={`${key}:${index}`}>{run.text}</React.Fragment>
      : <RecordChip key={`${key}:${index}`} kind={run.kind} value={run.value} label={run.label} />))
    : undefined), [mentions]);

  return (
    <MarkdownNodes
      tokens={tokens}
      renderText={renderText}
      highlight={highlight}
      className="min-w-0 w-full max-w-full break-words prose-content text-[var(--text-strong)]"
    />
  );
});

export default MarkdownContent;
