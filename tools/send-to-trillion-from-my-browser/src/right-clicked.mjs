// extension/src/right-clicked.mjs
//
// PURPOSE
//   Runs in every page. When the person right-clicks, it notes the thing they clicked on as the page itself marks it,
//   so "Add to Trillion" adds that thing and not just the page's address: the nearest post, comment or card (an
//   article element, a role="article" element, or an itemscope element), its own address (a link wrapping a time
//   element, the way posts mark their timestamp), its text and its pictures.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows a site by name; it reads only what HTML says about itself.
//   2. It reads only on a right-click, or when this extension's own background worker asks it to read the whole page or to act on it
//      (src/page-actions.mjs)
//      in a window it opened for one of the person's Trillion runs (src/browser-runs.mjs readPage), and it answers
//      only this extension's own background worker.

import { actOnPage } from './page-actions.mjs';

const CONTAINER = 'article, [role="article"], [itemscope]';
const MAX_TEXT = 4000;
const MAX_PICTURES = 4;

function describe(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  const container = element?.closest(CONTAINER);
  if (!container) return null;
  const own = [...container.querySelectorAll('a[href]')].find(link => link.querySelector('time') && link.closest(CONTAINER) === container);
  const pictures = [...container.querySelectorAll('img[src]')]
    .filter(image => image.closest(CONTAINER) === container && image.naturalWidth >= 120 && image.naturalHeight >= 120)
    // Largest as drawn first: the post's own pictures before the small face beside a name.
    .sort((left, right) => right.width * right.height - left.width * left.height)
    .slice(0, MAX_PICTURES).map(image => image.currentSrc || image.src);
  const text = container.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  if (!text && !pictures.length) return null;
  return { kind: 'post', url: own?.href ?? null, text, pictures, time: own?.querySelector('time')?.getAttribute('datetime') ?? null };
}

document.addEventListener('contextmenu', event => {
  try { chrome.runtime.sendMessage({ right_clicked: describe(event.target) }); } catch {}
}, true);

// The whole page as it shows itself, for a run the person's Trillion handed to this browser: its address, title, text
// and links. Asked only by this extension's background worker (a page cannot send to it), in a window it opened.
chrome.runtime.onMessage.addListener((message, sender, answer) => {
  if (message?.act_on_page && sender.id === chrome.runtime.id && !sender.tab) {
    try { answer(actOnPage(message.act_on_page, { document, window })); } catch (error) { answer({ error: String(error?.message ?? error) }); }
    return undefined;
  }
  if (!message?.read_page || sender.id !== chrome.runtime.id || sender.tab) return undefined;
  const { max_text: maxText, max_links: maxLinks } = message.read_page;
  try {
    const links = [...document.querySelectorAll('a[href]')].slice(0, maxLinks).map(link => ({ text: link.innerText.trim().slice(0, 200), url: link.href }));
    answer({ url: location.href, title: document.title, text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxText), links });
  } catch (error) {
    answer({ error: String(error?.message ?? error) });
  }
  return undefined;
});
