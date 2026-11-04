// PORTED FROM: bitfield-packages/packages/chat/show/chat-logic.ts @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/chat-logic.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure functions for the chat UI — zero React/DOM dependencies. Every function
// here is a pure transformation: deterministic input -> output. This lets us
// test all chat logic without rendering components or mocking the DOM.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO imports from React, DOM, or any browser API
// 2. Every function is pure — no side effects, no global state
// 3. parseMarkdown escapes HTML BEFORE applying transforms (XSS prevention)
// 4. Code blocks are extracted to placeholders BEFORE escaping, restored AFTER
//    all markdown transforms — this prevents markdown syntax inside code blocks
//    from being transformed
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// TIMESTAMP FORMATTING
// ---------------------------------------------------------------------------

/**
 * Convert an ISO-8601 timestamp to a human-readable relative or absolute time.
 *
 * - Under 60s: "just now"
 * - Under 60min: "Nm ago"
 * - Under 24h: "Nh ago"
 * - Otherwise: locale date+time string
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// MARKDOWN PARSING — powered by `marked` (GFM-compliant)
// ---------------------------------------------------------------------------
//
// L063 structural elimination: using a real markdown parser handles the FULL
// GFM spec (tables, strikethrough, task lists, blockquotes, etc.) so no
// individual feature will ever require a new hand-rolled regex.
//
// Architecture:
// - Sync (parseMarkdown): marked.parse() with GFM — instant, no Shiki
// - Async (parseMarkdownAsync): marked.parse() + post-process code blocks
//   with Shiki syntax highlighting
// - Security: custom renderer escapes raw HTML blocks (XSS prevention)
// ---------------------------------------------------------------------------

import { Marked, type Token } from 'marked';

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Reverse HTML entity escaping (for extracting code from marked output before Shiki). */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

/** Shared marked instance with GFM + XSS prevention. */
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Escape raw HTML blocks in markdown source to prevent XSS.
    // Markdown-generated HTML (tables, lists, etc.) is unaffected — only
    // literal HTML tags in the source text are escaped.
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

/**
 * Convert markdown to HTML (synchronous). Full GFM support: tables, bold/italic,
 * headings, lists, code blocks, inline code, strikethrough, blockquotes, etc.
 *
 * Security: Raw HTML in source is escaped via custom renderer (XSS prevention).
 */
/**
 * Trillion: the tokens of a message's markdown (the same GFM instance), which the
 * React drawing in MarkdownContent reads in place of an HTML string.
 */
export function markdownTokens(content: string): Token[] {
  return md.lexer(content);
}

export function parseMarkdown(content: string): string {
  return md.parse(content) as string;
}

/**
 * Convert markdown to HTML with Shiki syntax highlighting for code blocks.
 *
 * Pipeline:
 * 1. Parse with marked (full GFM → HTML, including basic <pre><code> blocks)
 * 2. Post-process: find <pre><code> blocks in output, replace with Shiki-highlighted HTML
 *
 * Dynamic Import: Shiki is loaded lazily to keep the sync parseMarkdown() tree-shakeable.
 * Fallback: Unknown languages fall back to plain text (no highlighting, no crash).
 */
export async function parseMarkdownAsync(content: string): Promise<string> {
  const { highlightCode } = await import('./shiki-loader');

  // Step 1: Parse full markdown to HTML (code blocks get basic <pre><code> treatment)
  let html = md.parse(content) as string;

  // Step 2: Find all <pre><code> blocks and enhance with Shiki syntax highlighting
  const codeBlockRegex = /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g;
  const replacements: Array<{ original: string; highlighted: string }> = [];

  let match;
  while ((match = codeBlockRegex.exec(html)) !== null) {
    const [fullMatch, lang = '', escapedCode] = match;
    // Unescape HTML entities that marked escaped inside code blocks —
    // Shiki needs the original source text to tokenize correctly.
    const code = unescapeHtml(escapedCode);
    const highlighted = await highlightCode(code, lang);
    replacements.push({ original: fullMatch, highlighted });
  }

  for (const { original, highlighted } of replacements) {
    html = html.replace(original, highlighted);
  }

  return html;
}

// ---------------------------------------------------------------------------
// AUTO-SCROLL DETECTION
// ---------------------------------------------------------------------------

/**
 * Determine whether the chat panel should auto-scroll to the bottom.
 * Returns true when the user is within `threshold` pixels of the bottom.
 */
export function shouldAutoScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 100,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

// ---------------------------------------------------------------------------
// MESSAGE GROUPING
// ---------------------------------------------------------------------------

/** Minimal message shape needed for grouping. */
export interface GroupableMessage {
  type: string;
  [key: string]: unknown;
}

/** A group of consecutive messages from the same sender type. */
export interface MessageGroup {
  type: string;
  messages: GroupableMessage[];
}

/**
 * Group consecutive messages that share the same `type` field.
 * This allows the UI to visually cluster same-sender messages (e.g., collapse
 * avatar + timestamp to the first message in a cluster).
 */
export function groupConsecutiveMessages(
  messages: GroupableMessage[],
): MessageGroup[] {
  if (messages.length === 0) return [];

  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup = {
    type: messages[0].type,
    messages: [messages[0]],
  };

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].type === currentGroup.type) {
      currentGroup.messages.push(messages[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = {
        type: messages[i].type,
        messages: [messages[i]],
      };
    }
  }

  groups.push(currentGroup);
  return groups;
}
