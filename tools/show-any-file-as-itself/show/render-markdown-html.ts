// package-set://bitfield-studio/packages/file-content-renderer/show/render-markdown-html.ts
//
// File-viewer-owned markdown parser. No chat package dependency.

import { Marked } from 'marked';
import { highlightCode } from './highlight-code-html';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

function safeUrl(value: string): string {
  const decoded = value.trim().replace(/&colon;/gi, ':');
  return /^(?:https?:|mailto:|\/|#)/i.test(decoded) ? value : '#';
}

/** Marked escapes raw HTML above; this final gate removes active attribute
 * protocols from generated links/images before MarkdownBlock uses innerHTML. */
export function sanitizeRenderedMarkdownHtml(html: string): string {
  return html
    .replace(/\s(?:href|src)=(['"])(.*?)\1/gi, (attribute, quote: string, url: string) => (
      attribute.replace(url, safeUrl(url))
    ))
    .replace(/\son[a-z]+=(['"])[\s\S]*?\1/gi, '');
}

export function parseMarkdown(content: string): string {
  return sanitizeRenderedMarkdownHtml(markdown.parse(content) as string);
}

export async function parseMarkdownAsync(content: string): Promise<string> {
  let html = markdown.parse(content) as string;
  const codeBlockRegex = /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g;
  const replacements: Array<{ original: string; highlighted: string }> = [];

  let match;
  while ((match = codeBlockRegex.exec(html)) !== null) {
    const [original, lang = '', escapedCode] = match;
    const highlighted = await highlightCode(unescapeHtml(escapedCode), lang);
    replacements.push({ original, highlighted });
  }

  for (const { original, highlighted } of replacements) {
    html = html.replace(original, highlighted);
  }

  return sanitizeRenderedMarkdownHtml(html);
}
