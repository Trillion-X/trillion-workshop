// parts/ui/show/share-row/share-row-html.mjs
//
// A SHARE ROW FOR ANY SERVER-SENT PAGE, FROM DATA.
//
// Purpose: the row under an article, a changelog entry or a story that lets a reader pass it on: Copy link, one
// button per place (X, LinkedIn, and any place a caller's DATA adds), and the phone's own share sheet. The document
// page (`../document-page`) and the page sections (`../server-rendered-page`) both draw it from here, so every page
// shares the same way.
//
// Non-negotiable invariants:
//   1. Every caller value is escaped. The shared address must be an absolute web address; anything else draws no
//      row, so a row can never share a script address.
//   2. A place's address is its `href` template with {url} and {text} filled, each URI-encoded here; the filled
//      address is written only when it is an absolute web address. A new place is one DATA row (share-row.json or
//      the caller's `places`); this file names no place.
//   3. Without scripting the row still works: the places are plain links. Copy link and the phone's share sheet are
//      buttons that start hidden and are shown by SHARE_ROW_SCRIPT only where the browser can do them (the share
//      sheet only where the pointer is coarse, as on a phone).
//   4. No colour is written here. The row reads --share-* roles that each host maps from its own theme roles.
//
// Key concepts: `shareRowHtml(share)`, `shareHref(template, values)`, `SHARE_ROW_CSS`, `SHARE_ROW_SCRIPT`.

import { escapeHtml } from '../../../../../write-a-post-for-each-place/read-data/escape-html.mjs';
import DEFAULTS from './share-row.json' with { type: 'json' };

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const web = (value) => (typeof value === 'string' && /^https?:\/\/[^\s"<>]+$/i.test(value) ? value : null);

/** A place's address: `template` with {url} and {text} filled (URI-encoded); null unless the result is a web address. */
export function shareHref(template, values) {
  const filled = String(template ?? '').replace(/\{(url|text)\}/g, (whole, name) => encodeURIComponent(values?.[name] ?? ''));
  return web(filled);
}

// A mark from shape rows ({ view_box, filled, nodes: [[shape, attributes]] }); only shape elements and plain
// attribute names are written. A filled mark (a brand's logo) is painted, an outline mark is stroked.
const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
function markSvg(mark) {
  const nodes = Array.isArray(mark?.nodes) ? mark.nodes : [];
  const shapes = nodes.filter((node) => Array.isArray(node) && SHAPES.has(node[0])).map(([shape, attributes]) => `<${shape}${Object.entries(attributes ?? {})
    .filter(([name]) => /^[a-z][a-z-]*$/.test(name) && name !== 'key')
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')}/>`).join('');
  if (!shapes) return '';
  const box = /^[\d.\s-]+$/.test(String(mark?.view_box ?? '')) ? mark.view_box : '0 0 24 24';
  const paint = mark?.filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="share-row__mark" xmlns="http://www.w3.org/2000/svg" viewBox="${escapeHtml(box)}" ${paint} aria-hidden="true" focusable="false">${shapes}</svg>`;
}

/**
 * The row. share: { url (absolute web address), text (what the link is, e.g. its title), compact?: bool,
 * words?: { label, copy, copied, more }, places?: [{ id, label, aria_label, href, mark }], native?: false }. `native:
 * false` leaves out the phone's share sheet button (a page that just received a share). Words and places not
 * given come from share-row.json. Returns '' when there is no web address to share.
 */
export function shareRowHtml(share) {
  const url = web(share?.url);
  if (!url) return '';
  const words = { ...DEFAULTS.words, ...(share?.words ?? {}) };
  const places = Array.isArray(share?.places) ? share.places : DEFAULTS.places;
  const values = { url, text: text(share?.text) ?? '' };
  const placeLinks = places.map((place) => {
    const href = shareHref(place?.href, values);
    const label = text(place?.label);
    if (!href || !label) return '';
    return `<a class="share-row__place" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"`
      + ` aria-label="${escapeHtml(text(place?.aria_label) ?? label)}" title="${escapeHtml(label)}" data-share-place="${escapeHtml(text(place?.id) ?? label)}">`
      + `${markSvg(place?.mark) || `<span class="share-row__place-word">${escapeHtml(label)}</span>`}</a>`;
  }).join('');
  const marks = DEFAULTS.marks;
  return `<div class="share-row${share?.compact ? ' share-row--compact' : ''}" role="group" aria-label="${escapeHtml(words.label)}"`
    + ` data-share-row data-share-url="${escapeHtml(url)}" data-share-text="${escapeHtml(values.text)}">`
    + `<span class="share-row__label" aria-hidden="true">${escapeHtml(words.label)}</span>`
    + `<button class="share-row__copy" type="button" data-share-copy data-share-copied="${escapeHtml(words.copied)}" hidden>`
    + `<span class="share-row__copy-mark">${markSvg(marks.copy)}</span><span class="share-row__copy-done">${markSvg(marks.copied)}</span>`
    + `<span class="share-row__copy-label" aria-live="polite">${escapeHtml(words.copy)}</span></button>`
    + placeLinks
    + (share?.native === false ? '' : `<button class="share-row__place" type="button" data-share-native aria-label="${escapeHtml(words.more)}" title="${escapeHtml(words.more)}" hidden>${markSvg(marks.more)}</button>`)
    + '</div>';
}

// Colours are --share-* roles the host maps from its own theme; sizes keep every button a comfortable tap target.
export const SHARE_ROW_CSS = `
.share-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:36px 0 0}
.share-row [hidden]{display:none!important}
.share-row__label{margin-right:4px;font-size:14px;color:var(--share-muted)}
.share-row__copy{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 18px 0 14px;border:0;border-radius:999px;background:var(--share-strong);color:var(--share-on-strong);font:inherit;font-size:15px;font-weight:600;line-height:1;cursor:pointer;transition:transform .12s ease}
.share-row__copy-mark,.share-row__copy-done{display:inline-flex}
.share-row__copy-done,.share-row__copy[data-share-done] .share-row__copy-mark{display:none}
.share-row__copy[data-share-done] .share-row__copy-done{display:inline-flex}
.share-row__place{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:1px solid var(--share-line);border-radius:14px;background:var(--share-fill);color:var(--share-ink);text-decoration:none;font:inherit;cursor:pointer;transition:border-color .15s ease,transform .12s ease}
.share-row__place:hover{border-color:var(--share-ink)}
.share-row__copy:active,.share-row__place:active{transform:scale(.96)}
.share-row__copy:focus-visible,.share-row__place:focus-visible{outline:2px solid var(--share-focus);outline-offset:2px}
.share-row__mark{width:18px;height:18px}
.share-row__place-word{font-size:13px;font-weight:600}
.share-row--compact{gap:8px;margin-top:20px}
.share-row--compact .share-row__label{font-size:12px}
.share-row--compact .share-row__copy{min-height:36px;padding:0 14px 0 12px;font-size:14px}
.share-row--compact .share-row__place{width:36px;height:36px;border-radius:12px}
.share-row--compact .share-row__mark{width:16px;height:16px}
@media (max-width:480px){.share-row__label{display:none}}
@media (prefers-reduced-motion:reduce){.share-row__copy,.share-row__place{transition:none}.share-row__copy:active,.share-row__place:active{transform:none}}
`;

// Shows Copy link where the clipboard can be written and the share sheet where the device has one and the pointer
// is coarse (a phone or tablet), and wires both. A cancelled share sheet is not an error.
export const SHARE_ROW_SCRIPT = `(() => {
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  for (const row of document.querySelectorAll('[data-share-row]')) {
    const url = row.dataset.shareUrl;
    const text = row.dataset.shareText;
    const copy = row.querySelector('[data-share-copy]');
    if (copy && navigator.clipboard) {
      const label = copy.querySelector('.share-row__copy-label');
      const resting = label.textContent;
      let timer;
      copy.hidden = false;
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); } catch { return; }
        label.textContent = copy.dataset.shareCopied;
        copy.dataset.shareDone = '';
        clearTimeout(timer);
        timer = setTimeout(() => { label.textContent = resting; delete copy.dataset.shareDone; }, 1800);
      });
    }
    const native = row.querySelector('[data-share-native]');
    if (native && phone && typeof navigator.share === 'function') {
      native.hidden = false;
      native.addEventListener('click', () => { navigator.share({ title: text, text, url }).catch(() => {}); });
    }
  }
})();`;
