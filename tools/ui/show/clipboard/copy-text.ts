// packages/ui/show/clipboard/copy-text.ts
//
// =============================================================================
// PURPOSE — the universal "copy this text to the system clipboard".
// =============================================================================
//
// The text sibling of `copyImageBlobToClipboard` (L088 — shared UI bedrock).
// Every surface that copies a produced string (a share link, an outline, an
// exported document) goes through THIS one implementation, so the platform-
// reality below is solved exactly once (L063):
//
//   * The async Clipboard API (`navigator.clipboard.writeText`) needs a secure
//     context + user gesture + permission, and is ABSENT in some shells — the
//     macOS WKWebView presenter among them. A bare `navigator.clipboard?.
//     writeText(x)` there resolves undefined WITHOUT throwing, so the caller's
//     success path runs while nothing reached the clipboard (a fail-open lie).
//   * The legacy selection path (`document.execCommand('copy')` over a hidden
//     textarea) DOES work in WKWebView, so it is the fallback, not an error.
//
// FAIL-CLOSED (L090): returns `true` only when a write verifiably succeeded —
// the async API resolved, or `execCommand('copy')` reported true. Everything
// else returns `false` and never throws; the caller owns how to surface the
// failure (e.g. show the text itself so the user can copy manually).
//
// BLIND: it knows nothing about WHAT the text means. The producer owns meaning.
// =============================================================================

/** The legacy selection-based copy: hidden textarea + execCommand('copy').
 *  Returns exactly what the browser reports; restores prior focus either way. */
function copyViaSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const prior = document.activeElement as HTMLElement | null;
  const host = document.createElement('textarea');
  host.value = text;
  // Off-viewport + readonly: no visual flash, no soft-keyboard, no scroll jump.
  host.setAttribute('readonly', '');
  host.style.position = 'fixed';
  host.style.top = '-1000px';
  host.style.opacity = '0';
  document.body.appendChild(host);
  let ok = false;
  try {
    host.focus();
    host.select();
    host.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    host.remove();
    if (prior && typeof prior.focus === 'function') prior.focus();
  }
  return ok;
}

/**
 * Copy text to the system clipboard. Tries the async Clipboard API first, then
 * the legacy selection path. Returns true only on verified success; never throws.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / insecure context — fall through to the legacy path.
    }
  }
  return copyViaSelection(text);
}
