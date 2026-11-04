// parts/ui/show/site-nav/site-nav-look.mjs
//
// ONE SITE NAVIGATION, FROM DATA, FOR EVERY PAGE.
//
// Purpose: what the two renderers of a site's top navigation share, so a page drawn by React
// (`SiteNav.tsx`) and a page a server sends ready to read (`documentPageHtml` in
// `../document-page/document-page-html.mjs`) show the same items, in the same order, with the same
// look and the same behaviour:
//   - `siteNavEntries(nav)`: the one reading of the nav DATA both renderers draw from;
//   - `siteNavItems(nav)`: every destination in the order a reader meets them (what a test compares);
//   - `SITE_NAV_CSS`: the look, reading theme role tokens only;
//   - `siteNavHover(item, api)`: the mouse-hover timing of a menu (a short wait before it opens, a short wait before it
//     closes, and a safe path from the button to the card), the one copy both renderers run;
//   - `SITE_NAV_SCRIPT`: open and close for server-sent pages (hover, focus, click, touch, Escape).
//
// Non-negotiable invariants:
//   1. There are no item kinds in code. An entry with `menu` opens a menu of feature rows; any other
//      entry with `href` is a link; an action with `primary: true` is the call to action. A new item,
//      feature or action is a DATA row.
//   2. No colour value is written here; every colour is a theme role token (`--ink`, `--thread`,
//      `--grey-strong`, `--grey-soft`, `--surface-base`, `--paper-tint`, `--on-accent`, `--focus-ring`).
//   3. Hover timing and the pointer path live in `siteNavHover` only. `SiteNav.tsx` calls it and `SITE_NAV_SCRIPT`
//      carries its source (Function.prototype.toString), so it reads nothing outside its own body and arguments, and
//      the two renderers cannot drift.
//   4. The visible gap between a menu button and its card is 8px. The invisible hover bridge across that gap is no
//      wider than the card, so page margins beside the card never hold a menu open.
//   5. The script only flips `aria-expanded` on buttons that name what they open (`aria-controls`);
//      the CSS draws the open state from that attribute, so a page without the script still opens
//      its menus on hover and focus, and shows the whole nav on a narrow screen.

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function feature(row) {
  const name = text(row?.name);
  const href = text(row?.href);
  if (!name || !href) return null;
  const preview = row?.preview && text(row.preview.src)
    ? { src: row.preview.src, alt: text(row.preview.alt) ?? '', width: Number(row.preview.width) || 1280, height: Number(row.preview.height) || 800 }
    : null;
  return { id: text(row?.id) ?? name, name, line: text(row?.line) ?? '', icon: text(row?.icon), href, preview };
}

/**
 * nav: { label, items: [{ label, href } | { label, menu: { heading, items: [{ id, name, line, icon, href, preview }], footer: { label, line, href } } }], actions: [{ label, href, primary }] }
 * -> { label, items: [{ label, href } | { id, label, menu: { heading, items, footer } }], actions }
 */
export function siteNavEntries(nav) {
  const items = rows(nav?.items).map((entry, index) => {
    const label = text(entry?.label);
    if (!label) return null;
    if (entry?.menu) {
      const menuItems = rows(entry.menu.items).map(feature).filter(Boolean);
      const footer = text(entry.menu.footer?.label) && text(entry.menu.footer?.href)
        ? { label: entry.menu.footer.label, line: text(entry.menu.footer.line) ?? '', href: entry.menu.footer.href } : null;
      return { id: `site-nav-menu-${index}`, label, menu: { heading: text(entry.menu.heading), items: menuItems, footer } };
    }
    const href = text(entry?.href);
    return href ? { label, href } : null;
  }).filter(Boolean);
  const actions = rows(nav?.actions)
    .map((action) => (text(action?.label) && text(action?.href) ? { label: action.label, href: action.href, primary: action.primary === true } : null))
    .filter(Boolean);
  return { label: text(nav?.label) ?? 'Main', items, actions };
}

/** Every destination the nav offers, in reading order: what "the same navbar" means, checkably. */
export function siteNavItems(nav) {
  const entries = siteNavEntries(nav);
  const out = [];
  for (const entry of entries.items) {
    if (entry.menu) {
      out.push({ label: entry.label, href: null });
      for (const row of entry.menu.items) out.push({ label: row.name, href: row.href });
      if (entry.menu.footer) out.push({ label: entry.menu.footer.label, href: entry.menu.footer.href });
    } else {
      out.push({ label: entry.label, href: entry.href });
    }
  }
  for (const action of entries.actions) out.push({ label: action.label, href: action.href });
  return out;
}

export const SITE_NAV_CSS = `
.site-nav{position:relative;z-index:40;width:100%;box-sizing:border-box;font-family:inherit}
.site-nav *{box-sizing:border-box}
.site-nav__bar{position:relative;max-width:var(--site-nav-width,1200px);margin:0 auto;padding:18px 24px;display:flex;align-items:center;gap:28px}
.site-nav__brand{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;color:var(--words-primary, var(--ink));text-decoration:none;font-weight:600}
.site-nav__brand[data-brand-text="wordmark"]{font:600 24px/1.3 var(--font-display,Georgia,serif)}
.site-nav__brand-mark{display:block;width:10.5rem;max-width:100%;height:auto}
.site-nav__panel{flex:1 1 auto;display:flex;align-items:center;justify-content:space-between;gap:24px}
.site-nav__list{list-style:none;margin:0 auto;padding:0;display:flex;align-items:center;gap:24px}
.site-nav__item{position:static;margin:0}
.site-nav__link{display:inline-flex;align-items:center;gap:6px;padding:8px 0;border:0;background:none;font:inherit;font-size:15px;line-height:1;color:var(--words-primary, var(--ink));text-decoration:none;cursor:pointer;white-space:nowrap}
.site-nav__link:hover,.site-nav__link:focus-visible,.site-nav__trigger[aria-expanded="true"]{color:var(--words-accent, var(--thread))}
.site-nav__link,.site-nav__action:not(.site-nav__action--primary){position:relative}
.site-nav__link::after,.site-nav__action:not(.site-nav__action--primary)::after{content:"";position:absolute;left:0;right:0;bottom:1px;height:2px;border-radius:2px;background:var(--ground-accent, var(--thread));transform:scaleX(0);transform-origin:left center;transition:transform 200ms cubic-bezier(.22,1,.36,1)}
.site-nav__link:hover::after,.site-nav__link:focus-visible::after,.site-nav__trigger[aria-expanded="true"]::after,.site-nav__action:not(.site-nav__action--primary):hover::after{transform:scaleX(1)}
@media (prefers-reduced-motion:reduce){.site-nav__link::after,.site-nav__action::after{transition:none}}
.site-nav__link:focus-visible,.site-nav__feature:focus-visible,.site-nav__preview:focus-visible,.site-nav__menu-footer:focus-visible,.site-nav__toggle:focus-visible,.site-nav__action:focus-visible{outline:2px solid var(--focus-ring);outline-offset:3px;border-radius:6px}
.site-nav__chevron{width:12px;height:12px;transition:transform 160ms ease}
.site-nav__trigger[aria-expanded="true"] .site-nav__chevron{transform:rotate(180deg)}
.site-nav__menu{display:none;position:absolute;top:calc(50% + 14px);left:0;right:0;width:min(880px,calc(100% - 32px));margin:0 auto;padding-top:9.5px}
.site-nav:not([data-nav-ready]) .site-nav__item--menu:hover>.site-nav__menu,.site-nav:not([data-nav-ready]) .site-nav__item--menu:focus-within>.site-nav__menu,.site-nav__trigger[aria-expanded="true"]+.site-nav__menu{display:block;animation:site-nav-in 160ms cubic-bezier(.22,1,.36,1) both}
.site-nav__menu-card{width:100%;display:grid;grid-template-columns:minmax(0,1fr) 250px;border:1px solid var(--grey-soft);border-radius:18px;background:var(--ground-card, var(--paper-tint));box-shadow:0 24px 60px color-mix(in srgb,var(--ink) 14%,transparent);overflow:hidden}
.site-nav__menu-main{padding:20px}
.site-nav__menu-heading{margin:0 0 10px 12px;font-size:12px;color:var(--words-secondary, var(--grey-strong))}
.site-nav__features{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px}
.site-nav__feature{display:grid;grid-template-columns:36px minmax(0,1fr);gap:2px 12px;align-items:start;padding:12px;border-radius:12px;color:var(--words-primary, var(--ink));text-decoration:none}
.site-nav__feature:hover,.site-nav__feature:focus-visible{background:var(--ground-surface, var(--surface-base))}
.site-nav__feature-icon{grid-row:span 2;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--grey-soft);border-radius:10px;background:var(--ground-surface, var(--surface-base));color:var(--words-accent, var(--thread))}
.site-nav__feature-icon svg{width:18px;height:18px}
.site-nav__feature-name{font-size:15px;font-weight:600;line-height:1.3}
.site-nav__feature-line{font-size:13.5px;line-height:1.45;color:var(--words-secondary, var(--grey-strong))}
.site-nav__menu-side{display:flex;flex-direction:column;gap:14px;padding:20px;border-left:1px solid var(--grey-soft);background:var(--ground-surface, var(--surface-base))}
.site-nav__preview{display:grid;gap:8px;color:var(--words-primary, var(--ink));text-decoration:none}
.site-nav__preview-img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover;object-position:top;border:1px solid var(--grey-soft);border-radius:10px}
.site-nav__preview-name{font-size:14px;font-weight:600}
.site-nav__preview-line{font-size:13px;line-height:1.45;color:var(--words-secondary, var(--grey-strong))}
.site-nav__preview:hover .site-nav__preview-name{color:var(--words-accent, var(--thread))}
.site-nav__menu-footer{display:grid;gap:2px;padding-top:14px;border-top:1px solid var(--grey-soft);color:var(--words-primary, var(--ink));text-decoration:none}
.site-nav__menu-footer-label{font-size:14px;font-weight:600}
.site-nav__menu-footer-label::after{content:' \\2192';color:var(--words-accent, var(--thread))}
.site-nav__menu-footer-line{font-size:13px;color:var(--words-secondary, var(--grey-strong))}
.site-nav__menu-footer:hover .site-nav__menu-footer-label{color:var(--words-accent, var(--thread))}
.site-nav__actions{display:flex;align-items:center;gap:22px;flex:0 0 auto}
.site-nav__action{font-size:15px;color:var(--words-primary, var(--ink));text-decoration:none;white-space:nowrap}
.site-nav__action:hover{color:var(--words-accent, var(--thread))}
.site-nav__action--primary{padding:11px 20px;border-radius:999px;background:var(--ground-accent, var(--thread));color:var(--words-on-accent, var(--on-accent));font-weight:600}
.site-nav__action--primary:hover{color:var(--words-on-accent, var(--on-accent));background:var(--thread-deep,var(--ground-accent, var(--thread)))}
.site-nav__toggle{display:none;margin-left:auto;padding:9px 14px;border:1px solid var(--grey-soft);border-radius:999px;background:var(--ground-card, var(--paper-tint));font:inherit;font-size:14px;color:var(--words-primary, var(--ink));cursor:pointer}
@keyframes site-nav-in{from{opacity:0;transform:translate3d(0,-6px,0)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.site-nav__menu,.site-nav__chevron{animation:none!important;transition:none}}
@media (max-width:1400px){
.site-nav__toggle{display:inline-flex}
.site-nav__panel{display:none;position:absolute;top:100%;left:12px;right:12px;flex-direction:column;align-items:stretch;gap:12px;padding:12px;border:1px solid var(--grey-soft);border-radius:18px;background:var(--ground-card, var(--paper-tint));box-shadow:0 24px 60px color-mix(in srgb,var(--ink) 14%,transparent);max-height:calc(100vh - 90px);max-height:calc(100dvh - 90px);overflow:auto}
.site-nav:not([data-nav-ready]) .site-nav__panel,.site-nav__toggle[aria-expanded="true"]+.site-nav__panel{display:flex}
.site-nav__list{flex-direction:column;align-items:stretch;gap:0;margin:0}
.site-nav__link{width:100%;padding:12px;font-size:16px;border-radius:10px}
.site-nav__link::after{display:none}
.site-nav__link:hover,.site-nav__link:focus-visible{background:var(--ground-surface, var(--surface-base))}
.site-nav__trigger{justify-content:space-between}
.site-nav__menu{position:static;width:auto;margin:0;padding:0 0 8px}
.site-nav__trigger[aria-expanded="true"]+.site-nav__menu{animation:none}
.site-nav__menu-card{width:auto;margin:0;grid-template-columns:minmax(0,1fr);border:0;box-shadow:none;background:none}
.site-nav__menu-main{padding:0}.site-nav__menu-heading{display:none}
.site-nav__features{grid-template-columns:minmax(0,1fr)}
.site-nav__menu-side{border-left:0;border-top:1px solid var(--grey-soft);padding:12px;background:none}
.site-nav__preview{display:none}
.site-nav__actions{justify-content:space-between;padding:12px;border-top:1px solid var(--grey-soft)}
}
`;

/**
 * The mouse-hover timing of one menu item, shared by the React navbar and the server-sent pages' script.
 * A mouse resting on the item opens it softly after `open` ms (a pointer passing over opens nothing); leaving a softly
 * opened item closes it after `close` ms, and while the pointer is still inside the triangle from where it left to
 * the card's top edge (heading for the card) the close keeps waiting. Entering the item again cancels the close.
 * Only the mouse is handled; touch and keyboard are the caller's.
 * Whole in itself: SITE_NAV_SCRIPT carries this function's source, so it reads nothing outside its body.
 * `api` is { isOpen(), isSoft(), show(), hide() }; the item holds the card as `.site-nav__menu-card`.
 * @param {HTMLElement} item @param {{ isOpen: () => boolean, isSoft: () => boolean, show: () => void, hide: () => void }} api
 * @param {{ open?: number, close?: number }} [delays] @returns {{ cancel: () => void, destroy: () => void }}
 */
export function siteNavHover(item, api, delays) {
  const openAfter = delays && typeof delays.open === 'number' ? delays.open : 120;
  const closeAfter = delays && typeof delays.close === 'number' ? delays.close : 180;
  const doc = item.ownerDocument;
  let openTimer = 0;
  let closeTimer = 0;
  let apex = null;
  const side = (x, y, ax, ay, bx, by) => (x - bx) * (ay - by) - (ax - bx) * (y - by);
  // Is (x, y) inside the triangle from the point the pointer left at to the card's top edge?
  const heading = (x, y) => {
    const card = item.querySelector('.site-nav__menu-card');
    if (!apex || !card) return false;
    const box = card.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0) || !(apex.y < box.top)) return false;
    const one = side(x, y, apex.x, apex.y, box.left, box.top);
    const two = side(x, y, box.left, box.top, box.right, box.top);
    const three = side(x, y, box.right, box.top, apex.x, apex.y);
    return !((one < 0 || two < 0 || three < 0) && (one > 0 || two > 0 || three > 0));
  };
  const settle = () => {
    clearTimeout(closeTimer);
    closeTimer = 0;
    apex = null;
    doc.removeEventListener('pointermove', follow);
  };
  function close() {
    settle();
    if (api.isOpen() && api.isSoft()) api.hide();
  }
  function follow(event) {
    if (!closeTimer || !heading(event.clientX, event.clientY)) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, closeAfter);
  }
  const onEnter = (event) => {
    if (event.pointerType !== 'mouse') return;
    settle();
    if (api.isOpen() || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = 0;
      if (!api.isOpen()) api.show();
    }, openAfter);
  };
  const onLeave = (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(openTimer);
    openTimer = 0;
    if (!api.isOpen() || !api.isSoft()) return;
    settle();
    apex = { x: event.clientX, y: event.clientY };
    closeTimer = setTimeout(close, closeAfter);
    doc.addEventListener('pointermove', follow);
  };
  item.addEventListener('pointerenter', onEnter);
  item.addEventListener('pointerleave', onLeave);
  const cancel = () => {
    clearTimeout(openTimer);
    openTimer = 0;
    settle();
  };
  return {
    cancel,
    destroy: () => {
      cancel();
      item.removeEventListener('pointerenter', onEnter);
      item.removeEventListener('pointerleave', onLeave);
    },
  };
}

// Open and close for a server-sent page. Hover (mouse only, timed and with a safe path by siteNavHover) and keyboard
// focus open a menu softly; a click on a softly opened menu keeps it open, a second click closes it; touch opens on
// tap. Escape closes and returns focus to the button; a press outside the nav closes everything.
export const SITE_NAV_SCRIPT = `(()=>{${siteNavHover.toString()}
document.querySelectorAll('[data-site-nav]').forEach((nav)=>{
nav.setAttribute('data-nav-ready','');
const buttons=[...nav.querySelectorAll('button[aria-controls][aria-expanded]')];
let quiet=false;
const open=(b)=>b.getAttribute('aria-expanded')==='true';
const set=(b,value,soft)=>{b.setAttribute('aria-expanded',String(value));if(soft)b.setAttribute('data-soft','');else b.removeAttribute('data-soft');};
buttons.forEach((b)=>{
const item=b.closest('[data-nav-menu]');
const hover=item?siteNavHover(item,{isOpen:()=>open(b),isSoft:()=>b.hasAttribute('data-soft'),show:()=>set(b,true,true),hide:()=>set(b,false,false)}):null;
b.addEventListener('click',()=>{if(hover)hover.cancel();if(open(b)&&b.hasAttribute('data-soft')){b.removeAttribute('data-soft');return;}set(b,!open(b),false);});
if(!item)return;
b.addEventListener('focus',()=>{if(quiet){quiet=false;return;}if(!open(b)&&b.matches(':focus-visible'))set(b,true,true);});
item.addEventListener('focusout',(e)=>{if(!item.contains(e.relatedTarget))set(b,false,false);});
});
document.addEventListener('keydown',(e)=>{if(e.key!=='Escape')return;buttons.forEach((b)=>{if(!open(b))return;const inside=b.closest('[data-nav-menu]')?.contains(document.activeElement);set(b,false,false);if(inside){quiet=true;b.focus();}});});
document.addEventListener('pointerdown',(e)=>{if(!nav.contains(e.target))buttons.forEach((b)=>set(b,false,false));});
});})();`;
