// package-set://bitfield-studio/packages/file-content-renderer/show/highlight-code-html.ts
//
// File-viewer-owned code highlighting helper. No chat package dependency.

import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

const PRELOAD_LANGS = ['typescript', 'javascript', 'python', 'bash', 'json'] as const;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // The highlighter is fetched the first time code is drawn, never with the screen that shows it.
    highlighterPromise = import('shiki').then(({ createHighlighter }) => createHighlighter({
      themes: ['github-dark-default', 'github-light-default'],
      langs: [...PRELOAD_LANGS],
    }));
  }
  return highlighterPromise;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const targetLang = lang.trim() || 'text';

  if (!highlighter.getLoadedLanguages().includes(targetLang as any)) {
    try {
      await highlighter.loadLanguage(targetLang as any);
    } catch {
      return highlighter.codeToHtml(code, {
        lang: 'text',
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: false,
      });
    }
  }

  return highlighter.codeToHtml(code, {
    lang: targetLang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  });
}

export function highlightCodeSync(code: string, _lang: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}
