// A PAGE CAN PAINT WITHOUT SHIPPING A PROGRAM.
//
// The landing page declared an island: a mount element, a bundle URL and a
// stylesheet. The server emitted the empty mount element and a script tag, the
// bundle was never built by anything, the browser got a 404 for it, and the
// page rendered white. It answered 200 the whole time, so every check that
// asked whether the site was up said yes. Only a screenshot disagreed.
//
// The deeper problem is that a marketing page is CONTENT, and content does not
// need a program to appear. Shipping one means a build step, an asset
// directory, an environment variable and a deploy all have to be right before
// a sentence reaches a reader, and any one of them failing is a white page.
//
// So the words live in the page description, as DATA, and this turns them into
// HTML. The island is not removed: if a bundle ever exists it loads and
// hydrates over content that is already on screen, which is the right order
// anyway. A page with no sections and no bundle still renders nothing, but a
// page with sections cannot be blank.
//
// THERE ARE NO SECTION KINDS. A hero, a feature list, a pricing note and a
// footer are the same question with different parts filled in, so there is one
// section shape and every part is optional. Adding a new kind of section is
// writing different DATA, never a new branch here, and nothing in this file
// knows a single thing about what any page is selling.
//
// IT LIVES IN THE SHARED UI PACKAGE because it is the HTML sink. Application
// and process code hands this data and copy; only this owner writes the tags.

/** HTML-escape text going into an element or a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** A word from DATA used as part of a class name, so a stylesheet can treat a
 *  section differently without this file learning what the difference means.
 *  Anything that is not a plain word is dropped rather than escaped, because a
 *  class name is not a place to be clever. */
function emphasisClass(value) {
  const word = textOrNull(value);
  return word && /^[a-z][a-z0-9-]*$/.test(word) ? ` page-section--${word}` : '';
}

// A destination this owner is willing to emit. Same-page, same-site and
// ordinary web addresses are written; anything else is rendered as plain text,
// so a page description can never become a `javascript:` handler.
function safeHref(value) {
  const href = textOrNull(value);
  if (!href) return null;
  if (href.startsWith('/') || href.startsWith('#')) return href;
  return /^https?:\/\//i.test(href) ? href : null;
}

function actionHtml(action) {
  const label = textOrNull(action?.label);
  if (!label) return '';
  const href = safeHref(action?.href);
  if (!href) return `<span class="page-action">${escapeHtml(label)}</span>`;
  return `<a class="page-action" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** A labelled text box. Its name and kind are plain words from DATA (anything
 *  else drops the field), and it is always paired with its visible label, so a
 *  page can ask for a value without this file knowing what the value is for.
 *  Reading and sending the value is the page's own script's job. */
function fieldHtml(field) {
  const label = textOrNull(field?.label);
  const name = textOrNull(field?.name);
  const kind = textOrNull(field?.kind) ?? 'text';
  if (!label || !name || !/^[a-z][a-z0-9_-]*$/.test(name) || !/^[a-z]+$/.test(kind)) return '';
  const id = `page-field-${name}`;
  const hint = textOrNull(field?.placeholder);
  return '<div class="page-field">'
    + `<label class="page-field-label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>`
    + `<input class="page-field-input" id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="${escapeHtml(kind)}" autocomplete="off"${hint ? ` placeholder="${escapeHtml(hint)}"` : ''}/>`
    + '</div>';
}

/** A short label beside an item's heading, such as where a piece of work stands. Its tone is a plain word from
 *  DATA naming how loudly it reads (`attention`, `good`, `quiet`, or any other word a stylesheet gives meaning);
 *  this file never learns what the label says. */
function metaHtml(meta) {
  const label = textOrNull(typeof meta === 'string' ? meta : meta?.label);
  if (!label) return '';
  const tone = textOrNull(meta?.tone);
  const toneClass = tone && /^[a-z][a-z0-9-]*$/.test(tone) ? ` page-item-meta--${tone}` : '';
  return `<span class="page-item-meta${toneClass}">${escapeHtml(label)}</span>`;
}

/** One entry in a list. Besides a heading and body it may carry a meta label, lines of detail, its own fields and
 *  its own actions, so work can be answered where it is listed instead of on another page. */
function itemHtml(item) {
  const heading = textOrNull(item?.heading);
  const body = textOrNull(item?.body);
  const meta = metaHtml(item?.meta);
  const details = list(item?.details).map(textOrNull).filter(Boolean).map(line => `<p class="page-item-detail">${escapeHtml(line)}</p>`).join('');
  const fields = list(item?.fields).map(fieldHtml).join('');
  const actions = list(item?.actions).map(actionHtml).join('');
  if (!heading && !body && !details) return '';
  const top = heading || meta
    ? `<div class="page-item-top">${heading ? `<h3 class="page-item-heading">${escapeHtml(heading)}</h3>` : ''}${meta}</div>` : '';
  return '<li class="page-item">'
    + top
    + (body ? `<p class="page-item-body">${escapeHtml(body)}</p>` : '')
    + details
    + (fields ? `<div class="page-fields">${fields}</div>` : '')
    + (actions ? `<div class="page-item-actions">${actions}</div>` : '')
    + '</li>';
}

/** One section. Every part is optional; a section holding nothing renders
 *  nothing rather than an empty box with spacing around it. */
export function sectionHtml(section) {
  const eyebrow = textOrNull(section?.eyebrow);
  const heading = textOrNull(section?.heading);
  const body = textOrNull(section?.body);
  const items = list(section?.items).map(itemHtml).join('');
  const fields = list(section?.fields).map(fieldHtml).join('');
  const actions = list(section?.actions).map(actionHtml).join('');
  const inner = (eyebrow ? `<p class="page-eyebrow">${escapeHtml(eyebrow)}</p>` : '')
    + (heading ? `<h2 class="page-heading">${escapeHtml(heading)}</h2>` : '')
    + (body ? `<p class="page-body">${escapeHtml(body)}</p>` : '')
    + (items ? `<ul class="page-items">${items}</ul>` : '')
    + (fields ? `<div class="page-fields">${fields}</div>` : '')
    + (actions ? `<div class="page-actions">${actions}</div>` : '');
  if (!inner) return '';
  return `<section class="page-section${emphasisClass(section?.emphasis)}">${inner}</section>`;
}

export function pageSectionsHtml(sections) {
  return list(sections).map(sectionHtml).join('');
}

export function canonicalUrlFor(description, pathname = '/') {
  const value = description?.canonical_origin;
  if (typeof value !== 'string' || !/^https:\/\/[^/?#]+\/?$/.test(value)) return '';
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return '';
  try {
    const url = new URL(value);
    return url.username || url.password ? '' : `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

/**
 * The whole document for a hosted public page.
 *
 * The caller hands a description and the pieces it resolved for itself: the
 * scripts that carry server-known state, and the offers or other values its
 * sections were written against. It does not write a single tag, because a
 * process that emits its own markup is a second place tags are authored, and
 * the first white page came from exactly that kind of split.
 *
 * The sections go INSIDE the mount element, not beside it. A page that
 * declares sections paints them with no program and nothing to fetch; a bundle,
 * if one exists, mounts over the same element and replaces them, which is the
 * order a hydrating page should have had anyway: readable first, interactive
 * second. A page that declares neither is unchanged, and a page whose bundle
 * 404s now shows its words instead of white.
 */
export function pageShellHtml(description, { stateScripts = '' } = {}) {
  const island = description?.island ?? {};
  const sections = pageSectionsHtml(description?.sections);
  const canonicalUrl = canonicalUrlFor(description);
  const stylesheet = island.stylesheet_url
    ? `<link rel="stylesheet" href="${escapeHtml(island.stylesheet_url)}"/>` : '';
  const bundle = island.bundle_url
    ? `<script src="${escapeHtml(island.bundle_url)}" defer></script>` : '';
  // A page that can already be read has nowhere better to send a reader
  // without scripting, so the redirect is only emitted when the page would
  // otherwise be empty.
  const noscript = island.noscript_route && !sections
    ? `<noscript><meta http-equiv="refresh" content="0;url=${escapeHtml(island.noscript_route)}"/></noscript>` : '';
  return `<!doctype html><html lang="${escapeHtml(description?.language ?? 'en')}"`
    + ` data-theme="${escapeHtml(description?.theme ?? 'paper')}"><head>`
    + '<meta charset="utf-8"/>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + `<title>${escapeHtml(description?.title ?? '')}</title>`
    + `<meta name="description" content="${escapeHtml(description?.meta_description ?? '')}"/>`
    + (canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}"/>` : '')
    + stylesheet
    + `<style>${island.inline_css ?? 'html,body{margin:0;padding:0}'}</style>`
    + (sections ? `<style>${PAGE_SECTIONS_CSS}</style>` : '')
    + `</head><body>${stateScripts}`
    + `<div id="${escapeHtml(island.mount_element_id ?? 'root')}">${sections}</div>`
    + bundle
    + noscript
    + '</body></html>';
}

// Typography with room to breathe. Long copy is allowed to take more lines;
// nothing here tightens letter spacing or line height to fit more words into
// fewer of them, because that is how a page ends up technically containing its
// message and being unreadable.
export const PAGE_SECTIONS_CSS = `
:root{--page-ink:#111;--page-soft:#555;--page-line:#e4e4e4;--page-bg:#f5f5f5}
html,body{margin:0;padding:0;background:var(--page-bg);color:var(--page-ink)}
body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
line-height:1.6;-webkit-font-smoothing:antialiased}
.page-section{max-width:46rem;margin:0 auto;padding:5rem 1.5rem;border-bottom:1px solid var(--page-line)}
.page-section:last-child{border-bottom:0}
.page-eyebrow{margin:0 0 1rem;font-size:.8125rem;text-transform:uppercase;color:var(--page-soft)}
.page-heading{margin:0 0 1.25rem;font-size:2rem;line-height:1.25;font-weight:650}
.page-body{margin:0;font-size:1.125rem;color:var(--page-soft);max-width:38rem}
.page-items{margin:2.5rem 0 0;padding:0;list-style:none;display:grid;gap:2rem}
.page-item-heading{margin:0 0 .5rem;font-size:1.0625rem;font-weight:620}
.page-item-body{margin:0;color:var(--page-soft)}
.page-actions{margin-top:2.5rem;display:flex;flex-wrap:wrap;gap:1rem}
.page-action{display:inline-block;padding:.85rem 1.6rem;border-radius:.6rem;background:var(--page-ink);
color:var(--page-bg);text-decoration:none;font-weight:560}
.page-section--hero{padding-top:7rem;padding-bottom:6rem}
.page-section--hero .page-heading{font-size:3rem;line-height:1.15}
.page-section--hero .page-body{font-size:1.25rem;color:var(--page-ink)}
@media(min-width:48rem){.page-items{grid-template-columns:1fr 1fr;gap:2rem 2.5rem}}
.page-item-top{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.page-item-meta{flex:none;display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .6rem;border:1px solid var(--page-line);
border-radius:999px;font-size:.8125rem;color:var(--page-soft);background:#fff;white-space:nowrap}
.page-item-meta::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:currentColor;opacity:.7}
.page-item-meta--attention{color:#9a5b00;border-color:#f0d9b5;background:#fff8ec}
.page-item-meta--good{color:#1f7a44;border-color:#cde8d6;background:#f2fbf5}
.page-item-meta--quiet{color:var(--page-soft)}
.page-item-detail{margin:.35rem 0 0;color:var(--page-soft);font-size:.9375rem}
.page-item-actions{margin-top:.9rem;display:flex;flex-wrap:wrap;gap:.6rem}
.page-item-actions .page-action{padding:.45rem .9rem;font-size:.875rem;background:transparent;color:var(--page-ink);
border:1px solid var(--page-line)}
.page-field{display:grid;gap:.35rem;margin-top:.9rem}
.page-field-label{font-size:.875rem;color:var(--page-soft)}
.page-field-input{font:inherit;padding:.6rem .75rem;border:1px solid var(--page-line);border-radius:.5rem;background:#fff}
.page-action:focus-visible,.page-field-input:focus-visible{outline:2px solid var(--page-ink);outline-offset:2px}
.page-section--work{padding:2.5rem 1.5rem}
.page-section--work .page-heading{font-size:1.25rem;margin-bottom:.5rem}
.page-section--work .page-body{font-size:1rem}
.page-section--work .page-items{grid-template-columns:1fr;gap:0;margin-top:1.25rem;border-top:1px solid var(--page-line)}
.page-section--work .page-item{padding:1rem 0;border-bottom:1px solid var(--page-line)}
@media(hover:hover){.page-section--work .page-item-actions{opacity:0;transition:opacity .15s}
.page-section--work .page-item:hover .page-item-actions,.page-section--work .page-item:focus-within .page-item-actions,
.page-section--work .page-item:has(.page-fields) .page-item-actions{opacity:1}}
@media(prefers-reduced-motion:reduce){.page-section--work .page-item-actions{transition:none}}
`.trim();
