// packages/group/do-work/open-external.ts
//
// =============================================================================
// PURPOSE — open an external URL WITHOUT hijacking the host shell frame (#210).
// =============================================================================
//
// Programmatic `window.open(url, '_blank')` routes through the WKWebView UI
// delegate (`createWebViewWithConfiguration`). The desktop shell does not
// implement that delegate, so the macOS WKWebView falls back to loading the URL
// in the CURRENT frame — replacing the entire studio app (a user's #210: a
// notion.so link took over the whole WebView). This is the same class of bug as
// `window.prompt` being dead in the WKWebView (replaced by TextInputModal).
//
// A real anchor `target="_blank"` click instead routes through the NAVIGATION
// delegate (`decidePolicyForNavigationAction`), which shells configure to open
// external URLs in the system browser. In a plain browser it simply opens a new
// tab. Either way the board's own frame is NEVER navigated away. `noopener
// noreferrer` severs the opener reference (SP-class hardening).
//
// BLIND (L090): given any href string, it opens it the safe way. It knows
// nothing about WHAT the link is. Empty href or no DOM (SSR/test) → no-op. A
// dangerous URL SCHEME is refused here (fail-closed sink), not trusted.
// =============================================================================

/** The only schemes allowed to reach the anchor sink. A `javascript:`/`data:`/`vbscript:`/`blob:`/
 *  `file:` href in an anchor CLICK executes script or exfiltrates in the studio's OWN origin, and a
 *  link href can arrive from an UNTRUSTED imported/shared board — so the sink itself fails closed on
 *  any explicit non-safe scheme (L063 category fix at the one navigation sink). A schemeless
 *  (relative) href carries no script vector and is allowed (opens as a normal URL). */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** True iff `href`'s explicit scheme (if any) is one an external-open may safely navigate to.
 *  A schemeless (relative) href has no scheme → true. Exported so callers can pre-gate an href
 *  (e.g. hide a broken/hostile link affordance) with the exact same rule the sink enforces (SSOT). */
export function isSafeExternalHref(href: string | null | undefined): boolean {
  if (!href) return false;
  // Detect the scheme on a whitespace/control-stripped copy — browsers strip tab/newline/space from a
  // URL before parsing, so "java\tscript:x" would otherwise slip past a naive scheme check.
  const forScheme = href.replace(/[\u0000-\u0020]/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(forScheme);
  return !m || SAFE_SCHEMES.has(m[1].toLowerCase());
}

/** Open `href` in a new context without ever navigating the current frame. */
export function openExternalHref(href: string | null | undefined): void {
  if (!href || typeof document === 'undefined') return;
  if (!isSafeExternalHref(href)) return; // fail closed on a dangerous scheme (javascript:/data:/…)
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
