/**
 * packages/screen-look/read-data/resolve-render-descriptor.ts
 *
 * =============================================================================
 * PURPOSE
 * =============================================================================
 *
 * Resolves a `render-descriptor` DATA record to render a source item (Slack
 * thread, X bookmark, etc.) with native look. Mirrors the screen-look palette
 * resolver pattern: DATA (render-descriptor shape) → concrete HTML rendering.
 *
 * Owner: screen-look (L088 — the palette/theme resolver owns this). Consumed by
 * composition-scene-renderer when rendering Container nodes with sourceInsertion.
 *
 * =============================================================================
 * NON-NEGOTIABLE INVARIANTS (L090 — self-describing, no vendor branches)
 * =============================================================================
 *
 * 1. Descriptor-driven: the renderDescriptorRef DISCRIMINANT selects the descriptor
 *    from DATA. No `if vendor == 'slack'` or `switch(source)` branches in this file.
 * 2. Generic default: absent or unknown descriptor → plain text + image fallback.
 * 3. Fail-closed: malformed descriptor → generic default, never crash.
 * 4. Data-driven tokens: descriptor.css_tokens maps token names (bubble_bg, text_color)
 *    to concrete CSS variable names; palette resolves tokens at render time.
 *
 * =============================================================================
 */

import type { ScreenLookTheme } from './resolve-screen-look-palette';
import { resolveScreenLookPalette } from './resolve-screen-look-palette';

/**
 * A render-descriptor DATA shape. Describes how a source item renders.
 * (Codex Round 2 verified: only essential fields for T6 proof; extensible.)
 */
export interface RenderDescriptor {
  readonly kind: 'render-descriptor';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Input contract the descriptor expects (e.g., "atom", "image"). */
  readonly input_contract: string;
  /** The template describing layout + components. */
  readonly template?: {
    readonly layout?: string; // "bubble" | "card" | "embed" | etc.
    readonly components?: readonly unknown[]; // generic array, resolver interprets per layout
  };
  /** Token names → CSS variable names for color/spacing resolution. */
  readonly css_tokens?: Record<string, string>;
}

/**
 * Source item data shape (canonical atom + metadata). */
export interface SourceItemData {
  readonly text?: string;
  readonly speaker?: string;
  readonly at?: string | number; // timestamp
  readonly attributes?: Record<string, unknown>;
  readonly output_contract?: string;
  readonly render_descriptor_ref?: string;
  readonly [key: string]: unknown;
}

/**
 * Resolves a render-descriptor to HTML. The resolver is pure and deterministic:
 * (descriptor, sourceData, screenLookTheme) → HTML string.
 *
 * Generic default when descriptor is null/unknown: renders plain text + image
 * (fall-back to L083 maximally useful default).
 *
 * Consumed by composition-scene-renderer to render Container nodes with sourceInsertion.
 */
export function resolveSourceRenderDescriptor(
  descriptor: RenderDescriptor | null,
  sourceData: SourceItemData | null,
  screenLookTheme: ScreenLookTheme | null,
): string {
  // Fail-closed: no descriptor or data → generic default
  if (!descriptor || !sourceData) {
    return renderGenericDefault(sourceData, screenLookTheme);
  }

  // Descriptor-driven rendering per layout type
  const layout = descriptor.template?.layout ?? 'generic';

  if (layout === 'bubble') {
    return renderBubbleLayout(descriptor, sourceData, screenLookTheme);
  } else if (layout === 'card') {
    return renderCardLayout(descriptor, sourceData, screenLookTheme);
  } else if (layout === 'embed') {
    return renderEmbedLayout(descriptor, sourceData, screenLookTheme);
  }

  // Unknown layout → generic default
  return renderGenericDefault(sourceData, screenLookTheme);
}

/**
 * Renders a bubble layout (Slack-like thread messages).
 * Descriptor describes: avatar, name, timestamp, message text.
 */
function renderBubbleLayout(
  descriptor: RenderDescriptor,
  sourceData: SourceItemData,
  screenLookTheme: ScreenLookTheme | null,
): string {
  const tokens = resolveScreenLookPalette(screenLookTheme || undefined) || {};
  const tokenMap = descriptor.css_tokens || {};

  const bubbleBg = tokens[tokenMap.bubble_bg || '--glass-bg-primary'] || 'rgba(31, 41, 55, 0.88)';
  const textColor = tokens[tokenMap.text_color || '--text-primary'] || '#f8fafc';
  const borderColor = tokens[tokenMap.border_color || '--border-primary'] || 'rgba(56, 189, 248, 0.24)';
  const fontFamily = tokens['--font-primary'] || 'system-ui, sans-serif';
  const bodySize = tokens['--font-size-body'] || '0.875rem';
  const labelSize = tokens['--font-size-label'] || '0.75rem';
  const captionSize = tokens['--font-size-caption'] || '0.75rem';

  const speaker = sourceData.speaker ? escapeHtml(String(sourceData.speaker)) : 'Unknown';
  const text = sourceData.text ? escapeHtml(String(sourceData.text)) : '';
  const timestamp = formatTimestamp(sourceData.at);

  // PROOF descriptor: render:slack-thread-bubble
  const avatarUrl = sourceData.attributes?.avatar_url
    ? escapeHtml(String(sourceData.attributes.avatar_url))
    : '';

  const html = `
    <div class="render-descriptor-bubble" style="
      background: ${bubbleBg};
      color: ${textColor};
      border: 1px solid ${borderColor};
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
      font-family: ${fontFamily};
      font-size: ${bodySize};
      line-height: 1.4;
    ">
      <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
        ${avatarUrl ? `<img src="${avatarUrl}" alt="${speaker}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;" />` : ''}
        <div>
          <div style="font-weight: 500; font-size: ${labelSize};">${speaker}</div>
          <div style="font-size: ${captionSize}; opacity: 0.7;">${timestamp}</div>
        </div>
      </div>
      <div style="white-space: pre-wrap; word-break: break-word;">${text}</div>
    </div>
  `;
  return html.trim();
}

/**
 * Renders a card layout (image + metadata, e.g., Pinterest pins).
 */
function renderCardLayout(
  descriptor: RenderDescriptor,
  sourceData: SourceItemData,
  screenLookTheme: ScreenLookTheme | null,
): string {
  const tokens = resolveScreenLookPalette(screenLookTheme || undefined) || {};
  const tokenMap = descriptor.css_tokens || {};

  const cardBg = tokens[tokenMap.bubble_bg || '--glass-bg-primary'] || 'rgba(31, 41, 55, 0.88)';
  const textColor = tokens[tokenMap.text_color || '--text-primary'] || '#f8fafc';
  const borderColor = tokens[tokenMap.border_color || '--border-primary'] || 'rgba(56, 189, 248, 0.24)';
  const fontFamily = tokens['--font-primary'] || 'system-ui, sans-serif';
  const bodySize = tokens['--font-size-body'] || '0.875rem';

  const imageUrl = sourceData.attributes?.image_url
    ? escapeHtml(String(sourceData.attributes.image_url))
    : '';
  const title = sourceData.text ? escapeHtml(String(sourceData.text).substring(0, 100)) : '';

  const html = `
    <div class="render-descriptor-card" style="
      background: ${cardBg};
      color: ${textColor};
      border: 1px solid ${borderColor};
      border-radius: 8px;
      overflow: hidden;
      max-width: 300px;
      font-family: ${fontFamily};
    ">
      ${imageUrl ? `<img src="${imageUrl}" alt="${title}" style="width: 100%; height: 200px; object-fit: cover; display: block;" />` : ''}
      <div style="padding: 12px; font-size: ${bodySize}; line-height: 1.4;">${title}</div>
    </div>
  `;
  return html.trim();
}

/**
 * Renders an embed layout (video/link embeds).
 */
function renderEmbedLayout(
  descriptor: RenderDescriptor,
  sourceData: SourceItemData,
  screenLookTheme: ScreenLookTheme | null,
): string {
  const tokens = resolveScreenLookPalette(screenLookTheme || undefined) || {};
  const tokenMap = descriptor.css_tokens || {};

  const embedBg = tokens[tokenMap.bubble_bg || '--glass-bg-primary'] || 'rgba(31, 41, 55, 0.88)';
  const textColor = tokens[tokenMap.text_color || '--text-primary'] || '#f8fafc';
  const borderColor = tokens[tokenMap.border_color || '--border-primary'] || 'rgba(56, 189, 248, 0.24)';
  const fontFamily = tokens['--font-primary'] || 'system-ui, sans-serif';
  const bodySize = tokens['--font-size-body'] || '0.875rem';
  const captionSize = tokens['--font-size-caption'] || '0.75rem';

  const title = sourceData.text ? escapeHtml(String(sourceData.text)) : 'Embedded content';
  const url = sourceData.attributes?.url ? escapeHtml(String(sourceData.attributes.url)) : '';

  const html = `
    <div class="render-descriptor-embed" style="
      background: ${embedBg};
      color: ${textColor};
      border: 1px solid ${borderColor};
      border-left: 4px solid ${borderColor};
      border-radius: 4px;
      padding: 12px;
      margin: 8px 0;
      font-family: ${fontFamily};
      font-size: ${bodySize};
    ">
      <div style="font-weight: 500; margin-bottom: 4px;">${title}</div>
      ${url ? `<div style="font-size: ${captionSize}; opacity: 0.7; word-break: break-all;"><a href="${url}" target="_blank" style="color: inherit; text-decoration: underline;">${url}</a></div>` : ''}
    </div>
  `;
  return html.trim();
}

/**
 * Generic default renderer: plain text + image fallback (L083).
 * Maximally useful: renders what exists, no crash on malformed data.
 */
function renderGenericDefault(
  sourceData: SourceItemData | null,
  screenLookTheme: ScreenLookTheme | null,
): string {
  const tokens = resolveScreenLookPalette(screenLookTheme || undefined) || {};
  const fontFamily = tokens['--font-primary'] || 'system-ui, sans-serif';
  const bodySize = tokens['--font-size-body'] || '0.875rem';
  const captionSize = tokens['--font-size-caption'] || '0.75rem';
  const textColor = tokens['--text-primary'] || '#f8fafc';
  const borderColor = tokens['--border-primary'] || 'rgba(56, 189, 248, 0.24)';

  if (!sourceData) {
    return `<div style="color: ${textColor}; border: 1px solid ${borderColor}; padding: 8px; border-radius: 4px;">[Empty source]</div>`;
  }

  const text = sourceData.text ? escapeHtml(String(sourceData.text)) : '';
  const imageUrl = sourceData.attributes?.image_url ? escapeHtml(String(sourceData.attributes.image_url)) : '';

  let html = '<div style="border: 1px solid ' + borderColor + '; border-radius: 4px; padding: 8px; color: ' + textColor + ';">';
  if (imageUrl) {
    html += `<img src="${imageUrl}" alt="source" style="max-width: 100%; height: auto; border-radius: 4px; margin-bottom: 8px; display: block;" />`;
  }
  if (text) {
    html += `<div style="font-family: ${fontFamily}; font-size: ${bodySize}; line-height: 1.4; white-space: pre-wrap; word-break: break-word;">${text}</div>`;
  } else if (!imageUrl) {
    html += `<div style="opacity: 0.7; font-size: ${captionSize};">[No content]</div>`;
  }
  html += '</div>';

  return html;
}

/**
 * Format timestamp to human-readable relative time.
 */
function formatTimestamp(at: string | number | undefined): string {
  if (!at) return '';

  const timestamp = typeof at === 'string' ? parseInt(at, 10) : at;
  if (!isFinite(timestamp)) return '';

  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString();
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

export type { ScreenLookTheme };
