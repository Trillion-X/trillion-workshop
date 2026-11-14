// parts/ui/show/composer/link-in-paste.ts
//
// The one rule for when something pasted is a link: exactly one http(s) address, trimmed, with nothing around it
// (words around an address are words). The composer and every screen that takes a pasted link use this rule.

/** The one http(s) address a paste is, as the browser writes it; null when the paste is anything else. */
export function linkInPaste(pasted: string): string | null {
  const text = pasted.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
