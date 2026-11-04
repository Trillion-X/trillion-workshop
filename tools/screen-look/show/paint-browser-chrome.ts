// parts/screen-look/show/paint-browser-chrome.ts
//
// Keeps the page's <meta name="theme-color"> on the worn look's ground, so a phone's status bar and the browser's own
// bar never stay white over a dark look (or black over a light one). Called by ApplyCurrentScreenLook.tsx
// applyScreenLookValues, the one way a look reaches the page.

import { browserChromeColour } from '../read-data/browser-chrome-colour.mjs';

/** The phone's status bar and the browser's own bar follow the worn look's ground (read-data/browser-chrome-colour.mjs,
 *  the same colour the server page shell wrote): the page's one `theme-color` is set to it (made when the page has
 *  none), and any per-scheme copy is dropped, because the look, not the device's light or dark setting, decides what the
 *  top of the page is. A look with no plain ground colour leaves the tag as it was. */
export function paintBrowserChrome(doc: Document, resolvedVariables: Record<string, string>): void {
  const colour = browserChromeColour(resolvedVariables);
  if (!colour || !doc.head) return;
  const tags = [...doc.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const tag = tags.find(meta => !meta.hasAttribute('media')) ?? doc.createElement('meta');
  for (const other of tags) if (other !== tag) other.remove();
  tag.name = 'theme-color';
  if (tag.content !== colour) tag.content = colour;
  if (!tag.isConnected) doc.head.append(tag);
}
