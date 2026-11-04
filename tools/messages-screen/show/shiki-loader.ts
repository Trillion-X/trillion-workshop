// PORTED FROM: bitfield-packages/packages/chat/show/shiki-loader.ts @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/read-data/shiki-loader.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Singleton lazy-loader for the Shiki syntax highlighter. Loads once on first
// use, caches the Promise, and provides both async (full highlight) and sync
// (escaped fallback) functions for code highlighting.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Single Promise cached — multiple calls to getHighlighter() return same Promise
// 2. Top 5 languages preloaded on init (typescript, javascript, python, bash, json)
// 3. Additional languages lazy-loaded on demand via highlighter.loadLanguage()
// 4. Unknown languages fall back to 'text' mode (plain text, no highlighting)
// 5. Sync fallback (highlightCodeSync) requires NO async dependencies — safe to call immediately
// 6. Dual themes (light + dark) via CSS variables — theme switching is CSS-only, zero JS
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// Shiki (about 150 kB with its grammars engine) arrives with the first code drawn, never with the screen that shows it.
import type { Highlighter } from 'shiki';

// ---------------------------------------------------------------------------
// SINGLETON HIGHLIGHTER MANAGEMENT
// ---------------------------------------------------------------------------

let highlighterPromise: Promise<Highlighter> | null = null;

/** Languages to preload on Shiki init. Most common in participant output. */
const PRELOAD_LANGS = ['typescript', 'javascript', 'python', 'bash', 'json'] as const;

/**
 * Get the Shiki highlighter instance. Lazily loads on first call and caches
 * the Promise. Subsequent calls return the same Promise (no re-initialization).
 *
 * Preloads github-dark-default + github-light-default themes and top 5
 * languages. Additional languages are lazy-loaded on demand via
 * highlighter.loadLanguage(). Dual themes enable CSS-variable-based
 * light/dark switching with zero runtime JS.
 */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) => createHighlighter({
      themes: ['github-dark-default', 'github-light-default'],
      langs: [...PRELOAD_LANGS],
    }));
  }
  return highlighterPromise;
}

// ---------------------------------------------------------------------------
// ASYNC HIGHLIGHTING (Full Syntax Highlighting)
// ---------------------------------------------------------------------------

/**
 * Syntax-highlight a code block using Shiki. Returns HTML <pre><code> with
 * span tokens for each syntax element.
 *
 * @param code - The code string to highlight
 * @param lang - The language identifier (e.g., 'typescript', 'python'). If
 *               unknown, falls back to 'text' (plain, unhighlighted)
 * @returns Promise<string> — HTML string with shiki token spans using CSS
 *          variables (--shiki-light, --shiki-dark) instead of hardcoded colors
 *
 * **Dual themes:** Uses `themes: { light, dark }` with `defaultColor: false`
 * so Shiki outputs CSS variables on each token. The active theme is selected
 * purely via CSS rules in global.css — zero JS theme detection needed.
 *
 * **Error handling:** Unknown languages silently fall back to 'text' mode.
 * This prevents a single bad language tag from breaking the entire message.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();

  // Normalize empty string to 'text'
  const targetLang = lang.trim() || 'text';

  // Check if language is already loaded
  const loadedLangs = hl.getLoadedLanguages();
  if (!loadedLangs.includes(targetLang as any)) {
    try {
      // Attempt to load the language on demand
      await hl.loadLanguage(targetLang as any);
    } catch {
      // If load fails (language not found in Shiki), fall back to 'text'
      // This prevents unknown language tags from causing errors
      return hl.codeToHtml(code, {
        lang: 'text',
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: false,
      });
    }
  }

  // Highlight with the resolved language
  return hl.codeToHtml(code, {
    lang: targetLang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  });
}

// ---------------------------------------------------------------------------
// SYNC HIGHLIGHTING (Fallback — No Async Dependencies)
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters. Used for sync fallback highlighting when
 * Shiki is not yet loaded.
 *
 * Converts:
 * - & → &amp;
 * - < → &lt;
 * - > → &gt;
 * - " → &quot;
 * - ' → &#039;
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Synchronous fallback for code highlighting when Shiki is not yet available.
 * Returns escaped HTML inside <pre><code> tags — no syntax highlighting, but
 * safe to render immediately without waiting for Shiki to load.
 *
 * This is used as the initial render in MarkdownContent, then swapped out
 * for the Shiki-highlighted version once shiki finishes loading.
 *
 * @param code - The code string to escape and wrap
 * @param _lang - Language identifier (ignored for sync fallback, kept for API consistency)
 * @returns string — HTML <pre><code> with escaped content
 */
export function highlightCodeSync(code: string, _lang: string): string {
  const escaped = escapeHtml(code);
  return `<pre><code>${escaped}</code></pre>`;
}
