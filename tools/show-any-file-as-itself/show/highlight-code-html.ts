// package-set://bitfield-studio/packages/file-content-renderer/show/highlight-code-html.ts
//
// File-viewer-owned code highlighting helper. No chat package dependency.
//
// The highlighter is the core build with the JavaScript regex engine and one grammar module per language in CODE_LANGS. The
// root `shiki` entry bundles every grammar Shiki has (about 9 MB), which every page that shows a file would carry. Unknown
// languages are drawn as plain text, as before.

import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import githubDark from 'shiki/dist/themes/github-dark-default.mjs';
import githubLight from 'shiki/dist/themes/github-light-default.mjs';
import bash from 'shiki/dist/langs/bash.mjs';
import css from 'shiki/dist/langs/css.mjs';
import diff from 'shiki/dist/langs/diff.mjs';
import go from 'shiki/dist/langs/go.mjs';
import html from 'shiki/dist/langs/html.mjs';
import javascript from 'shiki/dist/langs/javascript.mjs';
import json from 'shiki/dist/langs/json.mjs';
import jsx from 'shiki/dist/langs/jsx.mjs';
import markdown from 'shiki/dist/langs/markdown.mjs';
import python from 'shiki/dist/langs/python.mjs';
import rust from 'shiki/dist/langs/rust.mjs';
import shellscript from 'shiki/dist/langs/shellscript.mjs';
import sql from 'shiki/dist/langs/sql.mjs';
import swift from 'shiki/dist/langs/swift.mjs';
import tsx from 'shiki/dist/langs/tsx.mjs';
import typescript from 'shiki/dist/langs/typescript.mjs';
import yaml from 'shiki/dist/langs/yaml.mjs';

/** The languages a file view can colour, by Shiki's language name. The one list: a language not in it is drawn as plain text. */
const CODE_LANGS = { bash, css, diff, go, html, javascript, json, jsx, markdown, python, rust, shellscript, sql, swift, tsx, typescript, yaml };
type CodeLang = keyof typeof CODE_LANGS;

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    // The highlighter is made the first time code is drawn, never with the screen that shows it. Its languages load on first use.
    highlighterPromise = createHighlighterCore({
      themes: [githubDark, githubLight],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
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
  const requested = lang.trim();
  const isCodeLang = Object.hasOwn(CODE_LANGS, requested);
  if (isCodeLang && !highlighter.getLoadedLanguages().includes(requested as CodeLang)) {
    await highlighter.loadLanguage(CODE_LANGS[requested as CodeLang] as any);
  }
  const targetLang = isCodeLang ? requested : 'text';
  return highlighter.codeToHtml(code, {
    lang: targetLang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  });
}

export function highlightCodeSync(code: string, _lang: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}
