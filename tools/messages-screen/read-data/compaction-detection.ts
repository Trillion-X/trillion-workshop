// PORTED FROM: bitfield-packages/packages/chat/read-data/compaction-detection.ts @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/read-data/compaction-detection.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure string classifiers for messages that arrive as role='human' but are
// actually system-generated or from agent teammates. These mis-attributed
// messages need role correction before rendering.
//
// L063: Structural elimination — one module handles the entire CATEGORY of
// "role correction for mis-attributed human messages" rather than scattering
// detection logic across consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure string classification utility — no React/runtime dependencies
// 2. Conservative matching: requires unambiguous structural indicators
// 3. Shared by transcript mapping (ChatView), live chat/session readers,
//    and chat renderers
//
// =============================================================================

// ---------------------------------------------------------------------------
// COMPACTION SUMMARY DETECTION
// ---------------------------------------------------------------------------

/**
 * Returns true when content matches the standard context-compaction summary
 * emitted after the prior conversation ran out of context.
 */
export function isCompactionSummaryContent(content: string): boolean {
  if (!content.trim()) return false;
  const normalized = content.toLowerCase().replace(/\s+/g, ' ');

  const hasContinuation = normalized.includes('continued from a previous conversation');
  const hasContextLimit = normalized.includes('ran out of context');
  const hasSummaryLead =
    normalized.includes('summary below covers the earlier portion of the conversation')
    || normalized.includes('summary below covers the earlier portion');

  return hasContinuation && (hasContextLimit || hasSummaryLead);
}

// ---------------------------------------------------------------------------
// TEAMMATE MESSAGE DETECTION
// ---------------------------------------------------------------------------

/** Parsed teammate message identity + inner content. */
export interface ParsedTeammateMessage {
  id: string;
  color: string;
  summary: string;
  content: string;
}

/** Regex to match a <teammate-message> block. */
const TEAMMATE_MSG_RE =
  /<teammate-message\s+teammate_id="([^"]+)"([^>]*)>([\s\S]*?)<\/teammate-message>/;

const COLOR_RE = /color="([^"]*)"/;
const SUMMARY_RE = /summary="([^"]*)"/;

/**
 * Returns true when content contains a <teammate-message> XML wrapper,
 * indicating it originated from an agent teammate rather than the human user.
 */
export function isTeammateMessage(content: string): boolean {
  return TEAMMATE_MSG_RE.test(content);
}

/**
 * Parse the first <teammate-message> block from content.
 * Returns the teammate identity and stripped inner content, or null if not a teammate message.
 */
export function parseTeammateMessage(content: string): ParsedTeammateMessage | null {
  const match = TEAMMATE_MSG_RE.exec(content);
  if (!match) return null;

  const [, teammateId, attrs, innerContent] = match;
  const colorMatch = COLOR_RE.exec(attrs);
  const summaryMatch = SUMMARY_RE.exec(attrs);

  return {
    id: teammateId,
    color: colorMatch?.[1] ?? '',
    summary: summaryMatch?.[1] ?? '',
    content: innerContent.trim(),
  };
}
