// tools/ui/show/consent-banner/consent-banner.mjs
//
// The cookie consent bar for a static built page: the consent default every site starts from, the Accept / Decline bar, and
// the stylesheet the bar draws with. A site passes its own consent block (its rows, checked by the site) and gets the same
// bar, the same first-party cookie and the same gtag consent update everywhere. Names and words are the site's data; nothing
// here names a site, a vendor or a container.
//
//   consentDefaultScript(consent)  the script that runs first in <head>: every storage type denied, then granted again only when
//                                  the cookie already holds "granted" (so the answer survives a reload before any tag runs).
//   consentBannerScript(consent)   the script that shows the bar when no answer is kept. Accept and Decline are the same element
//                                  with the same class, so neither is easier. A kept answer ("granted" or "denied") is never asked for again.
//   consentBannerStyle()           the bar's stylesheet: Screen Look tokens, a visible focus ring, reduced motion honoured.
//
// Invariants:
//   - The cookie is first-party, SameSite=Lax, Secure, Path=/, and its Max-Age is at most 395 days.
//   - Nothing is granted before Accept. Decline writes "denied" and sends no update.
//   - No inline styles: the bar takes its look from the class names in consent-banner.css.
//   - Words and names are written with JSON that cannot close the script or open a comment (see inScript).
import { CONSENT_BANNER_CSS } from './consent-banner-style.mjs';

const MAX_AGE_LIMIT_SECONDS = 395 * 24 * 60 * 60;
const COOKIE_NAME = /^[A-Za-z0-9_]+$/;

const script = (code) => `<script>${code}</script>`;
// JSON that can sit inside a script: no character can close the script tag or open a comment.
const inScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** Throws, naming the field, when a consent block cannot drive the bar. The site's own checks run first; this guards the part. */
function assertConsent(consent) {
  if (!consent || !Array.isArray(consent.storage_types) || consent.storage_types.length === 0) throw new Error('consent.storage_types must list the storage types.');
  if (!consent.cookie || !COOKIE_NAME.test(consent.cookie.name ?? '')) throw new Error('consent.cookie.name must be letters, digits or underscores.');
  const maxAge = consent.cookie.max_age_seconds;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > MAX_AGE_LIMIT_SECONDS) throw new Error('consent.cookie.max_age_seconds must be a whole number up to 395 days.');
  for (const key of ['label', 'message', 'accept', 'decline']) {
    if (typeof consent.banner?.[key] !== 'string' || consent.banner[key].trim() === '') throw new Error(`consent.banner.${key} needs words.`);
  }
}

const statesFor = (types, value) => Object.fromEntries(types.map((type) => [type, value]));

export function consentDefaultScript(consent) {
  assertConsent(consent);
  const { storage_types: types, cookie } = consent;
  return script(
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
      `gtag('consent','default',${inScript(statesFor(types, 'denied'))});` +
      `(function(){var m=document.cookie.match(new RegExp('(?:^|; )${cookie.name}=([^;]*)'));if(m&&m[1]==='granted')gtag('consent','update',${inScript(statesFor(types, 'granted'))});})();`,
  );
}

export function consentBannerScript(consent) {
  assertConsent(consent);
  const { storage_types: types, cookie, banner } = consent;
  return script(
    `(function(){var NAME=${inScript(cookie.name)},MAX=${cookie.max_age_seconds},GRANTED=${inScript(statesFor(types, 'granted'))},WORDS=${inScript(banner)};` +
      `function saved(){var m=document.cookie.match(new RegExp('(?:^|; )'+NAME+'=([^;]*)'));return m?m[1]:null;}` +
      `if(saved()==='granted'||saved()==='denied')return;` +
      `function show(){var bar=document.createElement('div');bar.className='consent-banner';bar.setAttribute('role','region');bar.setAttribute('aria-label',WORDS.label);` +
      `var words=document.createElement('p');words.className='consent-banner-message';words.textContent=WORDS.message;bar.appendChild(words);` +
      `var row=document.createElement('div');row.className='consent-banner-actions';` +
      `function leave(){var main=document.querySelector('main')||document.body;if(!main.hasAttribute('tabindex'))main.setAttribute('tabindex','-1');main.focus();bar.remove();release();}` +
      `function choose(value){document.cookie=NAME+'='+value+'; Max-Age='+MAX+'; Path=/; SameSite=Lax; Secure';if(value==='granted')gtag('consent','update',GRANTED);leave();}` +
      `[['accept','granted'],['decline','denied']].forEach(function(pair){var b=document.createElement('button');b.type='button';b.className='consent-banner-button';b.textContent=WORDS[pair[0]];` +
      `b.addEventListener('click',function(){choose(pair[1]);});row.appendChild(b);});` +
      `bar.appendChild(row);document.body.appendChild(bar);` +
      `var root=document.documentElement,observer=null;` +
      `function reserve(){root.style.setProperty('--consent-banner-reserve',bar.offsetHeight+'px');}` +
      `function release(){if(observer)observer.disconnect();window.removeEventListener('resize',reserve);root.style.removeProperty('--consent-banner-reserve');document.body.classList.remove('consent-banner-open');}` +
      `document.body.classList.add('consent-banner-open');reserve();window.addEventListener('resize',reserve);` +
      `if(typeof ResizeObserver==='function'){observer=new ResizeObserver(reserve);observer.observe(bar);}}` +
      `if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);else show();})();`,
  );
}

// The stylesheet is a string in consent-banner-style.mjs (generated from consent-banner.css), so a bundle needs no file beside it.
export function consentBannerStyle() {
  return CONSENT_BANNER_CSS;
}
