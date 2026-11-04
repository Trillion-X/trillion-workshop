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
// IT LIVES IN THE SHARED UI PART because it is the HTML sink. Application
// and process code hands this data and copy; only this owner writes the tags.

import { escapeHtml } from '../../../../../write-a-post-for-each-place/read-data/escape-html.mjs';
import { SHARE_ROW_CSS, SHARE_ROW_SCRIPT, shareRowHtml } from '../share-row/share-row-html.mjs';
import { loadingMarkHtml } from '../loading-mark/loading-mark-html.mjs';
import { threadCoverHtml } from '../thread-cover/thread-cover.mjs';
import { markdownHtml } from '../document-page/document-page-html.mjs';
import { planCardHtml } from '../plan-card/plan-card-html.mjs';
import { PICTURE_READINESS_SCRIPT } from '../media-preview/picture-readiness.mjs';
import { PLAN_CARD_CSS } from '../../../../../screen-look/show/plan-card-style.mjs';
import { browserChromeColour } from '../../../../../screen-look/read-data/browser-chrome-colour.mjs';

export { escapeHtml };

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

/** A plain word from DATA as a class suffix (`page-action--quiet`), or nothing,
 *  so a stylesheet can give a word meaning without this file learning it. */
function wordClass(base, value) {
  const word = textOrNull(value);
  return word && /^[a-z][a-z0-9-]*$/.test(word) ? ` ${base}--${word}` : '';
}

/** What a pressed action says while its work runs and once it is done (page-work.mjs), from DATA `pending` and `done`. */
function workWords(action) {
  return ['pending', 'done'].map(name => {
    const words = textOrNull(action?.[name]);
    return words ? ` data-page-${name}="${escapeHtml(words)}"` : '';
  }).join('');
}

function actionHtml(action) {
  const label = textOrNull(action?.label);
  if (!label) return '';
  const href = safeHref(action?.href);
  const tone = wordClass('page-action', action?.tone);
  // `close`: `{ fallback }`, a button that closes this tab. A browser closes only a tab a page opened, so when the tab
  // stays open the button says `fallback` (how to close it by hand) instead.
  if (action?.close && typeof action.close === 'object') {
    const fallback = textOrNull(action.close.fallback);
    return `<button class="page-action${tone}" type="button" data-page-close${fallback ? ` data-page-close-fallback="${escapeHtml(fallback)}"` : ''}>${escapeHtml(label)}</button>`;
  }
  if (!href) return `<span class="page-action${tone}">${escapeHtml(label)}</span>`;
  // An action with `post` sends its plain named values to `href` when pressed, so a page can offer a choice that
  // changes something without a script. Names are plain words from DATA; anything else drops that value.
  if (action?.post && typeof action.post === 'object' && !href.startsWith('#')) {
    const values = Object.entries(action.post)
      .filter(([name, value]) => /^[a-z][a-z0-9_-]*$/.test(name) && (typeof value === 'string' || typeof value === 'number'))
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(String(value))}"/>`).join('');
    return `<form class="page-action-form" method="post" action="${escapeHtml(href)}">${values}<button class="page-action${tone}" type="submit"${workWords(action)}>${escapeHtml(label)}</button></form>`;
  }
  // `cooldown_seconds`: the page's script keeps the action waiting that long after each press (a resend), saying so.
  // `skip`: a plain word naming what this link declines (an offer the page makes), for the page's script to remember.
  // `again_seconds`: the page's script presses the action by itself after that long (a failure trying again).
  // `new_tab`: an address on another site opens in a new tab, never in place of this page.
  // `mark`: `{ src, alt? }`, a logo. `mark_after` places it after the words.
  const wait = Number.isInteger(action?.cooldown_seconds) && action.cooldown_seconds > 0 ? ` data-page-cooldown="${action.cooldown_seconds}"` : '';
  const again = Number.isInteger(action?.again_seconds) && action.again_seconds > 0 ? ` data-page-again="${action.again_seconds}"` : '';
  const skip = textOrNull(action?.skip);
  const skipped = skip && /^[a-z][a-z0-9-]*$/.test(skip) ? ` data-page-skip="${skip}"` : '';
  const mark = logoHtml(action?.mark, 'page-action-mark');
  const words = action?.mark?.underline === 'stitch' ? `<span class="page-action-label">${escapeHtml(label)}</span>` : escapeHtml(label);
  return `<a class="page-action${tone}" href="${escapeHtml(href)}"${newTab(action, href)}${wait}${again}${skipped}${workWords(action)}>${action?.mark_after === true ? words + mark : mark + words}</a>`;
}

/** `target` for a link that opens another site in a new tab (DATA `new_tab`), with no way back into this page. */
function newTab(item, href) {
  return item?.new_tab && /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

/** A logo from DATA (`{ src, alt?, loading? }`): a web or same-site address only. An absent alt makes it decorative.
 * Eager marks are above-the-fold attribution or identity, so they get fetch priority without making ordinary marks
 * compete with the page's content. */
function logoHtml(mark, className) {
  const at = safeHref(mark?.src);
  const alt = textOrNull(mark?.alt);
  const loading = mark?.loading === 'eager' ? 'eager' : 'lazy';
  const priority = loading === 'eager' ? ' fetchpriority="high"' : '';
  if (!at || at.startsWith('#')) return '';
  const image = `<img class="${className}" src="${escapeHtml(at)}" alt="${escapeHtml(alt ?? '')}"${alt ? '' : ' aria-hidden="true"'} loading="${loading}"${priority} decoding="async" referrerpolicy="no-referrer"/>`;
  return mark?.underline === 'stitch' ? `<span class="${className}-wrap">${image}${loadingMarkHtml('lg')}</span>` : image;
}

/** A picture from DATA, `{ src, alt }`: a web or same-site address only (anything else draws nothing) and its words
 *  for anyone who cannot see it. Pictures further down load when they near the screen; the picture in the section
 *  that carries the page's title (`first`) is the first thing seen, so it loads at once. */
function imageHtml(image, first = false) {
  const src = safeHref(image?.src);
  if (!src || src.startsWith('#')) return '';
  return `<img class="page-image" src="${escapeHtml(src)}" alt="${escapeHtml(textOrNull(image?.alt) ?? '')}"${first ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"/>`;
}

/** A file preview supplied as data. The browser streams video and audio from the supplied address. */
function mediaHtml(media, first = false) {
  const src = safeHref(media?.src);
  const type = textOrNull(media?.type) ?? '';
  if (!src || src.startsWith('#')) return '';
  if (type.startsWith('image/')) return imageHtml({ src, alt: media?.label }, first);
  // A live page (`text/html`): the page itself in a frame, loaded when it nears the screen, as tall as `height_px`
  // (`phone_height_px` on a narrow screen); `allow` names what the framed page may use (clipboard-write …).
  if (type === 'text/html') {
    const px = value => (Number.isInteger(value) && value > 0 && value <= 4000 ? value : null);
    const tall = [px(media?.height_px) ? `--page-frame-height:${px(media.height_px)}px` : '', px(media?.phone_height_px) ? `--page-frame-phone-height:${px(media.phone_height_px)}px` : ''].filter(Boolean).join(';');
    const allow = textOrNull(media?.allow);
    return `<iframe class="page-media page-media-frame" src="${escapeHtml(src)}" title="${escapeHtml(textOrNull(media?.label) ?? 'Live page')}" loading="lazy"`
      + `${allow && /^[a-z-]+(; ?[a-z-]+)*$/.test(allow) ? ` allow="${escapeHtml(allow)}"` : ''}${tall ? ` style="${tall}"` : ''}></iframe>`;
  }
  const tag = type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : null;
  if (!tag) return '';
  if (media?.player === true) {
    const label = textOrNull(media?.label) ?? 'Shared media';
    const transcript = safeHref(media?.transcript);
    const poster = safeHref(media?.poster);
    const firstPoster = media?.poster_loading === 'eager';
    const posterImage = tag === 'video' && poster && !poster.startsWith('#')
      ? `<img class="page-media-poster" src="${escapeHtml(poster)}" alt="" aria-hidden="true" loading="${firstPoster ? 'eager' : 'lazy'}"${firstPoster ? ' fetchpriority="high"' : ''} decoding="async"/>` : '';
    return `<div class="page-media page-media-player" role="group" aria-label="${escapeHtml(label)}" data-media-playback-url="${escapeHtml(src)}" data-media-playback-type="${escapeHtml(type)}" data-media-playback-label="${escapeHtml(label)}"`
      + `${transcript && !transcript.startsWith('#') ? ` data-media-playback-transcript="${escapeHtml(transcript)}"` : ''}`
      + `${poster && !poster.startsWith('#') ? ` data-media-playback-poster="${escapeHtml(poster)}"` : ''}`
      + `>${posterImage}<div class="page-media-mount"><a class="page-media-fallback" href="${escapeHtml(src)}">Open ${tag === 'video' ? 'video' : 'recording'}</a></div></div>`;
  }
  return `<${tag} class="page-media" src="${escapeHtml(src)}" controls preload="metadata"${tag === 'video' ? ' playsinline' : ''} aria-label="${escapeHtml(textOrNull(media?.label) ?? 'Shared media')}"></${tag}>`;
}

/** A list's saved views drawn another way, `[{ as, label, settings?, fields, rows }]`: one empty host for each, named by
 *  the view's own words and by `as` (the id of the view the page's script draws it with), holding what it draws as inert
 *  JSON. The script reads the host and draws into it; with no script, the section's own words and rows still read. The
 *  JSON cannot close its tag or start another: `<`, `>`, `&` and the two line separators leave as escapes. */
function viewsHtml(views) {
  return list(views).map(view => {
    const as = textOrNull(view?.as);
    if (!as) return '';
    const label = textOrNull(view?.label) ?? as;
    const data = JSON.stringify({ settings: view.settings ?? null, fields: list(view.fields), rows: list(view.rows), files: list(view.files) })
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<div class="page-view" role="group" aria-label="${escapeHtml(label)}" data-list-view="${escapeHtml(as)}"><script type="application/json" class="page-view-data">${data}</script></div>`;
  }).join('');
}

/** A drawing that opens a section, `{ src, alt }`, above its heading: a character that says how the page feels before a
 *  word is read. Same address rule as a picture. The drawing in the section that carries the page's title loads at
 *  once; any other loads when it nears the screen. Most drawings only set a mood, so an empty `alt` is the usual. */
function illustrationHtml(illustration, first = false) {
  const src = safeHref(illustration?.src);
  if (!src || src.startsWith('#')) return '';
  return `<img class="page-illustration" src="${escapeHtml(src)}" alt="${escapeHtml(textOrNull(illustration?.alt) ?? '')}"${first ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"/>`;
}

/** A row of choices that are links, such as filters over a list. Each chip is
 *  `{ label, href, count?, selected?, mark?, new_tab? }`; the selected one is marked for
 *  assistive technology and styled by the stylesheet, `mark` (`{ src }`) is a small logo before its words and `new_tab` opens
 *  another site in a new tab. */
function chipsHtml(chips) {
  const rows = list(chips).map(chip => {
    const label = textOrNull(chip?.label);
    const href = safeHref(chip?.href);
    if (!label || !href) return '';
    const count = Number.isFinite(chip?.count) ? `<span class="page-chip-count">${escapeHtml(chip.count)}</span>` : '';
    return `<a class="page-chip${chip?.selected ? ' page-chip--selected' : ''}" href="${escapeHtml(href)}"${newTab(chip, href)}${chip?.selected ? ' aria-current="page"' : ''}>${logoHtml(chip?.mark, 'page-chip-mark')}${escapeHtml(label)}${count}</a>`;
  }).join('');
  return rows ? `<nav class="page-chips">${rows}</nav>` : '';
}

/** One card in a browsable grid: the whole card is one link to `href`. It may
 *  carry a heading, a body, lines of detail and a meta label. */
function cardHtml(card, headingLevel = 3) {
  if (card?.plan) return planCardHtml(card.plan);
  const heading = textOrNull(card?.heading);
  const href = safeHref(card?.href);
  if (!heading) return '';
  const body = textOrNull(card?.body);
  const details = list(card?.details).map(textOrNull).filter(Boolean).map(line => `<p class="page-card-detail">${escapeHtml(line)}</p>`).join('');
  const meta = metaHtml(card?.meta);
  const inner = (cardCoverHtml(card?.cover) || imageHtml(card?.image))
    + `<h${headingLevel} class="page-card-heading">${escapeHtml(heading)}</h${headingLevel}>`
    + (body ? `<p class="page-card-body">${escapeHtml(body)}</p>` : '')
    + details
    + (meta ? `<div class="page-card-foot">${meta}</div>` : '');
  return `<li class="page-card${wordClass('page-card', card?.tone)}">${href ? `<a class="page-card-link" href="${escapeHtml(href)}">${inner}</a>` : inner}</li>`;
}

/** A card's visual cover, supplied as plain data. A picture or short passage takes the place of a glyph; a missing
 * preview keeps a deliberate cover instead of turning the card into a stack of labelled text. */
function cardCoverHtml(cover) {
  if (!cover || typeof cover !== 'object') return '';
  const src = safeHref(cover.src);
  const label = textOrNull(cover.label);
  const glyph = textOrNull(cover.glyph);
  const passage = textOrNull(cover.text);
  const hasPicture = !!src && !src.startsWith('#');
  if (!src && !label && !glyph && !passage) return '';
  const picture = passage && (!src || src.startsWith('#'))
    ? `<p class="page-card-cover-text">${escapeHtml(passage)}</p>`
    : `<span class="page-card-cover-glyph" aria-hidden="true">${escapeHtml(glyph ?? '·')}</span>`
      + (hasPicture ? `<img class="page-card-cover-image" data-picture-source src="${escapeHtml(src)}" alt="${escapeHtml(textOrNull(cover.alt) ?? '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"/>` : '');
  // Leave ordinary images visible without scripting; the adapter activates its loading appearance when it runs.
  return `<div class="page-card-cover"${hasPicture ? ' data-picture-frame' : ''}>${picture}`
    + (hasPicture ? `<span class="page-card-cover-loading" data-picture-loading hidden>${loadingMarkHtml('lg')}</span><span class="page-card-cover-unavailable" data-picture-unavailable hidden>Preview unavailable</span>` : '')
    + `${label ? `<span class="page-card-cover-label">${escapeHtml(label)}</span>` : ''}</div>`;
}

/** Bounded page navigation. The caller decides the addresses and the visible page window; this owner supplies
 * semantic links, active-page state and keyboard focus without learning what the paged things are. */
function paginationHtml(pagination) {
  const pages = list(pagination?.pages);
  if (!pages.length) return '';
  const label = textOrNull(pagination?.label) ?? 'Pages';
  const edge = (name, action) => {
    const words = textOrNull(action?.label) ?? name;
    const href = safeHref(action?.href);
    return href ? `<a class="page-pagination-edge" href="${escapeHtml(href)}" aria-label="${escapeHtml(words)}">${escapeHtml(words)}</a>`
      : `<span class="page-pagination-edge page-pagination-edge--disabled" aria-disabled="true">${escapeHtml(words)}</span>`;
  };
  const numbered = pages.map(page => {
    if (page?.ellipsis === true) return '<li class="page-pagination-gap" aria-hidden="true">…</li>';
    const number = Number.isSafeInteger(page?.number) && page.number > 0 ? page.number : null;
    if (!number) return '';
    const href = safeHref(page?.href);
    const current = page?.current === true;
    return `<li>${href && !current
      ? `<a class="page-pagination-number" href="${escapeHtml(href)}" aria-label="Page ${number}">${number}</a>`
      : `<span class="page-pagination-number page-pagination-number--current" aria-label="Page ${number}"${current ? ' aria-current="page"' : ''}>${number}</span>`}</li>`;
  }).join('');
  return `<nav class="page-pagination" aria-label="${escapeHtml(label)}">${edge('Previous', pagination.previous)}<ol class="page-pagination-pages">${numbered}</ol>${edge('Next', pagination.next)}</nav>`;
}

/** The link to the next part of a long list. Without scripting it is an
 *  ordinary link to the next page; PAGE_MORE_SCRIPT turns it into a list that
 *  keeps growing as the reader scrolls. */
function moreHtml(more) {
  const label = textOrNull(more?.label);
  const href = safeHref(more?.href);
  return label && href ? `<div class="page-more-row"><a class="page-more" href="${escapeHtml(href)}" data-page-more>${escapeHtml(label)}</a></div>` : '';
}

/** A choice sent as one form: `{ href, values, groups, fields?, submit }`. `values` are plain named values carried as
 *  they are (same rule as a posting action). Each group is `{ name, label?, multiple?, options }`; a group that allows
 *  several answers draws a tick box per option, one that allows a single answer draws one round choice per option.
 *  Each option is `{ value, label, detail?, checked?, depth? }`; `depth` (a whole number, 0 at the top) sets an
 *  option in under the one above it, so options read in tree order draw as a tree. `fields` are text boxes sent with the choices (fieldHtml),
 *  after the groups. `submit` is the sending button's `{ label, tone? }`. It works with no script: pressing the
 *  button posts every ticked value under its group's name and every field's words under its name. Names are plain
 *  words from DATA; anything else drops that group, field or value, so this file never learns what is being chosen. */
function choicesHtml(choices) {
  const href = safeHref(choices?.href);
  const submit = textOrNull(choices?.submit?.label);
  if (!href || href.startsWith('#') || !submit) return '';
  const plainName = name => typeof name === 'string' && /^[a-z][a-z0-9_-]*$/.test(name);
  const values = Object.entries(choices?.values && typeof choices.values === 'object' ? choices.values : {})
    .filter(([name, value]) => plainName(name) && (typeof value === 'string' || typeof value === 'number'))
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(String(value))}"/>`).join('');
  const groups = list(choices?.groups).map(group => {
    if (!plainName(group?.name)) return '';
    const kind = group.multiple ? 'checkbox' : 'radio';
    const drawn = list(group.options).map(option => {
      const label = textOrNull(option?.label);
      const value = textOrNull(option?.value);
      if (!label || !value) return null;
      const detail = textOrNull(option?.detail);
      const depth = Number.isInteger(option?.depth) && option.depth > 0 ? Math.min(option.depth, 8) : 0;
      return { checked: option.checked === true, html: `<label class="page-choice page-choice--${kind}${depth ? ' page-choice--nested' : ''}"${depth ? ` style="--page-choice-depth:${depth}"` : ''}>`
        + `<input class="page-choice-input" type="${kind}" name="${escapeHtml(group.name)}" value="${escapeHtml(value)}"${option.checked ? ' checked' : ''}/>`
        + '<span class="page-choice-mark" aria-hidden="true"></span>'
        + `<span class="page-choice-text"><span class="page-choice-label">${escapeHtml(label)}</span>`
        + (detail ? `<span class="page-choice-detail">${escapeHtml(detail)}</span>` : '')
        + '</span></label>' };
    }).filter(Boolean);
    // `fold` (a whole number) shows that many options and keeps the rest under a "more" line the person opens when they
    // want to see more; a ticked option is never hidden, and a fold of one extra option is not worth hiding.
    const fold = Number.isInteger(group.fold) && group.fold > 0 ? group.fold : 0;
    const more = textOrNull(group.more_label) ?? 'More';
    const shown = fold && drawn.length > fold + 1 ? drawn.slice(0, fold) : drawn;
    const hidden = drawn.slice(shown.length);
    const options = shown.map(row => row.html).join('')
      + (hidden.length ? `<details class="page-choice-more"${hidden.some(row => row.checked) ? ' open' : ''}><summary class="page-choice-more-line">${escapeHtml(more)}</summary>${hidden.map(row => row.html).join('')}</details>` : '');
    if (!options) return '';
    const legend = textOrNull(group.label);
    return `<fieldset class="page-choice-group">${legend ? `<legend class="page-choice-legend">${escapeHtml(legend)}</legend>` : ''}${options}</fieldset>`;
  }).join('');
  const fields = list(choices?.fields).map(fieldHtml).join('');
  // A form of fields alone (a name to save) is a choice with no groups.
  if (!groups && !fields) return '';
  // A form that carries files is sent as multipart, the only way a browser sends a file's bytes with a form.
  const carriesFiles = list(choices?.fields).some(field => field?.kind === 'file');
  return `<form class="page-choices" method="post" action="${escapeHtml(href)}"${carriesFiles ? ' enctype="multipart/form-data"' : ''}>${values}${groups}${fields ? `<div class="page-fields">${fields}</div>` : ''}`
    + `<button class="page-action page-choices-send${wordClass('page-action', choices?.submit?.tone)}" type="submit"${workWords(choices?.submit)}>${escapeHtml(submit)}</button></form>`;
}

/** A labelled text box. Its name and kind are plain words from DATA (anything
 *  else drops the field), and it is always paired with its visible label, so a
 *  page can ask for a value without this file knowing what the value is for.
 *  `lines` above 1 makes it a box for several lines of words; `max_length` caps
 *  how much can be typed and `min_length` asks for at least that much; `required`
 *  marks it as needed before its form is sent; `value` is what it already holds
 *  (a known email, a name), for the person to keep or change. `label_action`
 *  ({ label, href }) is a quiet link on the label's line, such as "Forgot
 *  password?". `reveal` ({ show, hide }: the words read aloud) puts an eye button
 *  inside the box that shows and hides what was typed (PAGE_REVEAL_SCRIPT).
 *  `kind: 'file'` asks for files (`multiple: true` for several) and makes its
 *  form multipart. `hint` is a line of words under the box, read with it; `strength: true` marks
 *  a new password whose hint the page's script rewrites as it is typed.
 *  `hidden: true` draws the field hidden, for the page's script to show when its
 *  step comes (the code that confirms an email, once it is sent). Inside
 *  a choice form its words are sent with the form; anywhere else, reading and
 *  sending the value is the page's own script's job. */
function fieldHtml(field) {
  const label = textOrNull(field?.label);
  const name = textOrNull(field?.name);
  const kind = textOrNull(field?.kind) ?? 'text';
  if (!label || !name || !/^[a-z][a-z0-9_-]*$/.test(name) || !/^[a-z]+$/.test(kind)) return '';
  if (kind === 'code') return codeFieldHtml(field, label, name);
  const id = `page-field-${name}`;
  const hint = textOrNull(field?.placeholder);
  const lines = Number.isInteger(field?.lines) && field.lines > 1 ? Math.min(field.lines, 12) : 1;
  const most = (Number.isInteger(field?.max_length) && field.max_length > 0 ? ` maxlength="${field.max_length}"` : '')
    + (Number.isInteger(field?.min_length) && field.min_length > 0 ? ` minlength="${field.min_length}"` : '')
    + (field?.required === true ? ' required' : '')
    + (kind === 'file' && field?.multiple === true ? ' multiple' : '')
    // What a file box offers: `accept` (kinds of file, like image/*) and `capture` (record now with the phone's own
    // camera or microphone, "user" or "environment") are plain words from DATA.
    + (kind === 'file' && /^[a-z0-9*\/.,+ -]{1,120}$/i.test(field?.accept ?? '') ? ` accept="${escapeHtml(field.accept)}"` : '')
    + (kind === 'file' && ['user', 'environment'].includes(field?.capture) ? ` capture="${field.capture}"` : '');
  const given = typeof field?.value === 'string' ? field.value : '';
  // What the field holds, for the browser's own fill-in (`email`, `one-time-code`) and the phone keyboard (`numeric`).
  const fill = textOrNull(field?.autocomplete);
  const keys = textOrNull(field?.inputmode);
  const note = textOrNull(field?.hint);
  const named = `class="page-field-input" id="${escapeHtml(id)}" name="${escapeHtml(name)}" autocomplete="${fill && /^[a-z -]+$/.test(fill) ? escapeHtml(fill) : 'off'}"${keys && /^[a-z]+$/.test(keys) ? ` inputmode="${escapeHtml(keys)}"` : ''}${most}${hint ? ` placeholder="${escapeHtml(hint)}"` : ''}`
    + (note ? ` aria-describedby="${escapeHtml(id)}-hint"` : '') + (field?.strength === true ? ' data-page-strength' : '');
  const labelHtml = `<label class="page-field-label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>`;
  const asideLabel = textOrNull(field?.label_action?.label);
  const asideHref = safeHref(field?.label_action?.href);
  const top = asideLabel && asideHref
    ? `<div class="page-field-top">${labelHtml}<a class="page-field-link" href="${escapeHtml(asideHref)}">${escapeHtml(asideLabel)}</a></div>` : labelHtml;
  const box = lines > 1 ? `<textarea ${named} rows="${lines}">${escapeHtml(given)}</textarea>` : `<input ${named} type="${escapeHtml(kind)}"${given ? ` value="${escapeHtml(given)}"` : ''}/>`;
  const show = textOrNull(field?.reveal?.show);
  const hide = textOrNull(field?.reveal?.hide);
  const revealed = lines === 1 && show && hide
    ? `<div class="page-field-box">${box}<button class="page-field-reveal" type="button" data-page-reveal aria-controls="${escapeHtml(id)}" aria-pressed="false" aria-label="${escapeHtml(show)}" data-show="${escapeHtml(show)}" data-hide="${escapeHtml(hide)}">${REVEAL_ICONS}</button></div>` : box;
  return `<div class="page-field"${field?.hidden === true ? ' hidden' : ''}>${top}${revealed}${note ? `<p class="page-field-hint" id="${escapeHtml(id)}-hint">${escapeHtml(note)}</p>` : ''}</div>`;
}

/** A one-time code typed one digit per box (`kind: "code"`, `length` boxes, 4 to 8): typing moves to the next box,
 *  Backspace and the arrow keys move back and forth, a pasted or filled-in code fills every box, and a full code
 *  announces itself (`page-code-complete`) for the page's script to send (PAGE_CODE_SCRIPT). The digits joined are the
 *  value of one hidden input under the field's `name`, so the page reads it like any other field. The label is read
 *  aloud and kept out of sight: the heading above the boxes already says what goes in them. */
function codeFieldHtml(field, label, name) {
  const length = Number.isInteger(field?.length) ? Math.min(Math.max(field.length, 4), 8) : 6;
  const id = `page-field-${name}`;
  const boxes = Array.from({ length }, (_, index) => `<input class="page-code-box" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="${index === 0 ? 'one-time-code' : 'off'}" aria-label="${escapeHtml(`${label}, digit ${index + 1} of ${length}`)}"/>`).join('');
  return `<div class="page-field page-field--code"${field?.hidden === true ? ' hidden' : ''}><span class="page-field-label page-field-label--unseen" id="${escapeHtml(id)}-label">${escapeHtml(label)}</span>`
    + `<div class="page-code" role="group" aria-labelledby="${escapeHtml(id)}-label" data-page-code>${boxes}<input type="hidden" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value=""/></div></div>`;
}

// Typing, deleting, moving, pasting and filling in a code's boxes, and saying when the code is whole.
export const PAGE_CODE_SCRIPT = `(function(){function B(g){return Array.prototype.slice.call(g.querySelectorAll('.page-code-box'))}`
  + `function S(g){var b=B(g),v=b.map(function(x){return x.value}).join('');g.querySelector('input[type=hidden]').value=v;var w=v.length===b.length;g.classList.toggle('page-code--full',w);if(w)g.dispatchEvent(new CustomEvent('page-code-complete',{bubbles:true,detail:{value:v}}))}`
  + `function F(g,i,t){var b=B(g),d=String(t).replace(/\\D/g,'').split('');for(var k=i;k<b.length&&d.length;k++)b[k].value=d.shift();var n=b.filter(function(x){return!x.value})[0];(n||b[b.length-1]).focus();S(g)}`
  + `function C(e){var x=e.target;return x&&x.classList&&x.classList.contains('page-code-box')?x:null}`
  + `document.addEventListener('input',function(e){var x=C(e);if(!x)return;var g=x.closest('[data-page-code]'),b=B(g),i=b.indexOf(x),v=x.value.replace(/\\D/g,'');if(v.length>1){x.value='';F(g,i,v);return}x.value=v;if(v&&i<b.length-1)b[i+1].focus();S(g)});`
  + `document.addEventListener('keydown',function(e){var x=C(e);if(!x)return;var g=x.closest('[data-page-code]'),b=B(g),i=b.indexOf(x);if(e.key==='Backspace'&&!x.value&&i>0){e.preventDefault();b[i-1].value='';b[i-1].focus();S(g)}else if(e.key==='ArrowLeft'&&i>0){e.preventDefault();b[i-1].focus()}else if(e.key==='ArrowRight'&&i<b.length-1){e.preventDefault();b[i+1].focus()}});`
  + `document.addEventListener('paste',function(e){var x=C(e);if(!x)return;e.preventDefault();var g=x.closest('[data-page-code]');F(g,B(g).indexOf(x),(e.clipboardData||window.clipboardData).getData('text'))});`
  + `document.addEventListener('focusin',function(e){var x=C(e);if(x)x.select()});`
  + `document.addEventListener('page-code-clear',function(e){var g=e.target.closest&&e.target.closest('[data-page-code]');if(!g)return;B(g).forEach(function(x){x.value=''});S(g);B(g)[0].focus()})})();`;

// The eye a reveal button wears: open while the words are hidden (press to show), struck through while they show.
const REVEAL_ICONS = '<svg class="page-reveal-show" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
  + '<svg class="page-reveal-hide" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';

// One press shows or hides what a reveal field holds, and says which it now does.
/** The close action (`close`): close the tab, and when the browser keeps it open, say how to close it by hand. */
export const PAGE_CLOSE_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-page-close]');if(!b)return;window.close();setTimeout(function(){if(!window.closed&&b.dataset.pageCloseFallback)b.textContent=b.dataset.pageCloseFallback},300)});`;

export const PAGE_REVEAL_SCRIPT =`document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-page-reveal]');if(!b)return;var f=document.getElementById(b.getAttribute('aria-controls'));if(!f)return;var on=f.type==='password';f.type=on?'text':'password';b.setAttribute('aria-pressed',String(on));b.setAttribute('aria-label',on?b.dataset.hide:b.dataset.show);});`;

/** A line with words between two hairlines, `divider: "or"`, between a section's form and its other actions. */
function dividerHtml(divider) {
  const words = textOrNull(divider);
  return words ? `<div class="page-divider" role="separator"><span class="page-divider-words">${escapeHtml(words)}</span></div>` : '';
}

/** One line of words ending in a link, `prompt: { text, action: { label, href } }`, such as "Don't have an
 *  account? Sign up". Without a usable link it draws nothing. */
function promptHtml(prompt) {
  const label = textOrNull(prompt?.action?.label);
  const href = safeHref(prompt?.action?.href);
  if (!label || !href) return '';
  const text = textOrNull(prompt?.text);
  return `<p class="page-prompt">${text ? `${escapeHtml(text)} ` : ''}<a class="page-prompt-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
}

/** Where a code was sent, `sent_to: { text, change: { label, href } }`: "Sent to <address>. Change email". The
 *  address is written in by the page's script once it knows it (`data-page-sent-to`). */
function sentToHtml(sentTo) {
  const text = textOrNull(sentTo?.text);
  if (!text) return '';
  const label = textOrNull(sentTo?.change?.label);
  const href = safeHref(sentTo?.change?.href);
  return `<p class="page-sent-to">${escapeHtml(text)} <strong class="page-sent-to-address" data-page-sent-to></strong>`
    + `${label && href ? ` <a class="page-sent-to-change" href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : ''}</p>`;
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
function itemHtml(item, headingLevel = 3) {
  const heading = textOrNull(item?.heading);
  const body = textOrNull(item?.body);
  const meta = metaHtml(item?.meta);
  const details = list(item?.details).map(textOrNull).filter(Boolean).map(line => `<p class="page-item-detail">${escapeHtml(line)}</p>`).join('');
  const fields = list(item?.fields).map(fieldHtml).join('');
  const actions = list(item?.actions).map(actionHtml).join('');
  if (!heading && !body && !details) return '';
  const top = heading || meta
    ? `<div class="page-item-top">${heading ? `<h${headingLevel} class="page-item-heading">${escapeHtml(heading)}</h${headingLevel}>` : ''}${meta}</div>` : '';
  return '<li class="page-item">'
    + top
    + (body ? `<p class="page-item-body">${escapeHtml(body)}</p>` : '')
    + details
    + (fields ? `<div class="page-fields">${fields}</div>` : '')
    + (actions ? `<div class="page-item-actions">${actions}</div>` : '')
    + '</li>';
}

/** Steps to follow in order, `[{ heading, body?, image?, actions? }]`: each one numbered on one rail (the numbered
 *  badges a connection's how-to steps wear, on the rail a changelog's entries share), with a picture when one helps
 *  (`image`, `{ src, alt, width?, height? }`, sized so the page does not jump while it loads) and its own buttons. The
 *  numbers come from the order; a step with no heading draws nothing. */
function stepsHtml(steps) {
  const rows = list(steps).filter(step => textOrNull(step?.heading)).map((step, index) => {
    const body = textOrNull(step.body);
    const src = safeHref(step.image?.src);
    const size = value => (Number.isInteger(value) && value > 0 ? value : null);
    const sized = size(step.image?.width) && size(step.image?.height) ? ` width="${step.image.width}" height="${step.image.height}"` : '';
    const picture = src && !src.startsWith('#')
      ? `<img class="page-step-image" src="${escapeHtml(src)}" alt="${escapeHtml(textOrNull(step.image?.alt) ?? '')}"${sized} loading="lazy" decoding="async"/>` : '';
    const actions = list(step.actions).map(actionHtml).join('');
    return '<li class="page-step">'
      + `<span class="page-step-number" aria-hidden="true">${index + 1}</span>`
      + '<div class="page-step-content">'
      + `<h3 class="page-step-heading">${escapeHtml(step.heading.trim())}</h3>`
      + (body ? `<p class="page-step-body">${escapeHtml(body)}</p>` : '')
      + picture
      + (actions ? `<div class="page-step-actions">${actions}</div>` : '')
      + '</div></li>';
  }).join('');
  return rows ? `<ol class="page-steps">${rows}</ol>` : '';
}

/** Letters for a face or a mark from a name: the first letter of its first two words, or nothing. */
function lettersOf(value) {
  const words = (textOrNull(value) ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map(word => [...word][0] ?? '').join('').toUpperCase();
}

/** A tile that says what a section is about before its words, `{ src?, alt?, name }`: the picture when there is one,
 *  else the first letters of `name` on the page's own ink, as a workspace or space is marked. */
function markHtml(mark) {
  const src = safeHref(mark?.src);
  const letters = lettersOf(mark?.name);
  if (src && !src.startsWith('#')) return `<img class="page-mark" src="${escapeHtml(src)}" alt="${escapeHtml(textOrNull(mark?.alt) ?? '')}" width="64" height="64" decoding="async"/>`;
  return letters ? `<span class="page-mark page-mark--letters" aria-hidden="true">${escapeHtml(letters)}</span>` : '';
}

/** Who is in something, `{ faces: [{ name, src? }], more?, line }`: a row of overlapping faces (a picture, else the
 *  name's first letters), a count of the rest, and one line of words. Names are read aloud once, by the line. */
function peopleHtml(people) {
  const faces = list(people?.faces).slice(0, 6).map(face => {
    const src = safeHref(face?.src);
    if (src && !src.startsWith('#')) return `<img class="page-face" src="${escapeHtml(src)}" alt="" width="36" height="36" decoding="async"/>`;
    const letters = lettersOf(face?.name);
    return letters ? `<span class="page-face">${escapeHtml(letters)}</span>` : '';
  }).join('');
  const more = Number.isInteger(people?.more) && people.more > 0 ? `<span class="page-face page-face--more">+${people.more}</span>` : '';
  const line = textOrNull(people?.line);
  if (!faces && !line) return '';
  return `<div class="page-people">${faces || more ? `<span class="page-faces" aria-hidden="true">${faces}${more}</span>` : ''}`
    + (line ? `<p class="page-people-line">${escapeHtml(line)}</p>` : '') + '</div>';
}

/** Words written as markdown (`markdown`), read by the one markdown renderer (../document-page markdownHtml) as a
 *  readable passage: headings, lists, quotes, tables, pictures, code. Links leave in a new tab. `markdown_breaks: true`
 *  keeps every line break inside a paragraph (plain words whose lines are meant). */
function proseHtml(markdown, breaks = false) {
  const words = textOrNull(markdown);
  return words ? `<div class="page-prose">${markdownHtml(words, { linkClass: 'page-prose-link', newTab: true, breaks })}</div>` : '';
}

/** One section. Every part is optional; a section holding nothing renders
 *  nothing rather than an empty box with spacing around it. */
export function sectionHtml(section, { titled = false } = {}) {
  const heading = textOrNull(section?.heading);
  const body = textOrNull(section?.body);
  // An empty status ('') is still drawn, as the line a page's script writes into while it works.
  const status = typeof section?.status === 'string' ? section.status.trim() : null;
  // A page's own title is its one first-level heading (`heading_level: 1`); every other heading is second level. What a
  // section lists sits one level under the section's own heading (second level when it has none), so headings never skip.
  const level = section?.heading_level === 1 && !titled ? 1 : 2;
  const under = heading ? level + 1 : 2;
  const items = list(section?.items).map(item => itemHtml(item, under)).join('');
  const itemsAfterActions = list(section?.items_after_actions).map(item => itemHtml(item, under)).join('');
  // `after_actions`: `{ divider?, chips? }`, a second way forward under the actions (a failure page's own AI), its
  // divider naming it.
  const afterChips = chipsHtml(section?.after_actions?.chips);
  const afterActions = afterChips ? dividerHtml(section?.after_actions?.divider) + afterChips : '';
  const fields = list(section?.fields).map(fieldHtml).join('');
  const actions = list(section?.actions).map(actionHtml).join('');
  const chips = chipsHtml(section?.chips);
  const cardRows = list(section?.cards);
  const cards = cardRows.map(card => cardHtml(card, under)).join('');
  const pagination = paginationHtml(section?.pagination);
  const steps = stepsHtml(section?.steps);
  const inner = illustrationHtml(section?.illustration, level === 1)
    + markHtml(section?.mark)
    + (heading ? `<h${level} class="page-heading">${escapeHtml(heading)}</h${level}>` : '')
    + (body ? `<p class="page-body">${escapeHtml(body)}</p>` : '')
    + proseHtml(section?.markdown, section?.markdown_breaks === true)
    + sentToHtml(section?.sent_to)
    + imageHtml(section?.image, level === 1)
    + mediaHtml(section?.media, level === 1)
    + viewsHtml(section?.views)
    + peopleHtml(section?.people)
    + chips
    + (items ? `<ul class="page-items">${items}</ul>` : '')
    + steps
    + (cards ? `<ul class="${cardRows.every(card => card?.plan) ? 'trillion-plan-cards' : 'page-cards'}" data-page-cards>${cards}</ul>` : '')
    + pagination
    + moreHtml(section?.more)
    + choicesHtml(section?.choices)
    + dividerHtml(section?.divider)
    + (fields ? `<div class="page-fields">${fields}</div>` : '')
    + (actions ? `<div class="page-actions">${actions}</div>` : '')
    + afterActions
    + (status !== null ? `<p class="page-status" role="status" aria-live="polite">${escapeHtml(status)}</p>` : '')
    + promptHtml(section?.prompt)
    + (itemsAfterActions ? `<ul class="page-items page-items--after-actions">${itemsAfterActions}</ul>` : '')
    + shareRowHtml(section?.share);
  if (!inner) return '';
  // `step`: which step of the page this section is (a plain word), for the page's script to show one step at a time;
  // `hidden: true` draws it out of sight until its step comes.
  const step = textOrNull(section?.step);
  const stepped = step && /^[a-z][a-z0-9-]*$/.test(step) ? ` data-page-step="${step}"` : '';
  return `<section class="page-section${emphasisClass(section?.emphasis)}"${stepped}${section?.hidden === true ? ' hidden' : ''}>${inner}</section>`;
}

/** A page has one title: when several sections ask for the first-level heading (the steps of a sign-in page), the first
 *  that has a heading keeps it and the others are second-level headings. */
export function pageSectionsHtml(sections) {
  let titled = false;
  return list(sections).map(section => {
    const html = sectionHtml(section, { titled });
    if (section?.heading_level === 1 && textOrNull(section?.heading)) titled = true;
    return html;
  }).join('');
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
/** The page's icons from DATA: each `{ rel, href, type?, sizes? }` becomes one
 *  link. The relation, type and sizes are plain tokens (anything else drops
 *  that icon or attribute) and the address must be one `safeHref` accepts, so a
 *  description can name its icons without this file knowing what they are. */
function iconLinksHtml(icons) {
  return list(icons).map(icon => {
    const rel = textOrNull(icon?.rel);
    const href = safeHref(icon?.href);
    if (!rel || !href || !/^[a-z][a-z -]*$/.test(rel)) return '';
    const type = textOrNull(icon?.type);
    const sizes = textOrNull(icon?.sizes);
    return `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}"`
      + (type && /^[a-z]+\/[a-z0-9.+-]+$/.test(type) ? ` type="${escapeHtml(type)}"` : '')
      + (sizes && /^(any|\d+x\d+( \d+x\d+)*)$/.test(sizes) ? ` sizes="${escapeHtml(sizes)}"` : '')
      + '/>';
  }).join('');
}

/** Structured data for search engines and answer engines, one script per
 *  object. Serialised by JSON.stringify with `<` escaped, so no value in it can
 *  close its script element. */
export function jsonLdHtml(values) {
  return list(values).filter(value => value && typeof value === 'object')
    .map(value => `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`).join('');
}

/** How a page looks when it is shared (Open Graph and its large-card twin),
 *  from `{ type, title, description, url, image, image_alt, site_name }`. Only
 *  absolute web addresses are written for the url and image. */
function shareMetaHtml(share) {
  if (!share || typeof share !== 'object') return '';
  const web = value => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);
  const rows = [
    ['property', 'og:type', textOrNull(share.type) ?? 'website'],
    ['property', 'og:site_name', textOrNull(share.site_name)],
    ['property', 'og:title', textOrNull(share.title)],
    ['property', 'og:description', textOrNull(share.description)],
    ['property', 'og:url', web(share.url)],
    ['property', 'og:image', web(share.image)],
    ['property', 'og:image:alt', textOrNull(share.image_alt)],
    ['name', 'twitter:card', web(share.image) && share.image_card !== 'summary' ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', textOrNull(share.title)],
    ['name', 'twitter:description', textOrNull(share.description)],
    ['name', 'twitter:image', web(share.image)],
  ];
  return rows.filter(([, , value]) => value).map(([kind, name, value]) => `<meta ${kind}="${name}" content="${escapeHtml(value)}"/>`).join('');
}

/** The page's look from DATA: `{ palette, stylesheets }`. `palette` is a screen-look palette, CSS variable name to
 *  concrete value (what `resolveScreenLookPalette` returns for a theme), written onto the root so this owner's own
 *  stylesheet reads the same roles every screen reads (--bg-primary, --text-primary, --button-primary-bg,
 *  --font-display, ...). A name must be a plain custom property and a value may not carry anything that could end the
 *  rule or the style element; anything else drops that one entry. `stylesheets` are addresses `safeHref` accepts
 *  (the look's font faces, for one), linked before this owner's rules. */
function lookHtml(look) {
  const entries = Object.entries(look?.palette && typeof look.palette === 'object' ? look.palette : {})
    .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && (typeof value === 'string' || typeof value === 'number')
      && String(value).length <= 400 && !/[<>{};\\]/.test(String(value)))
    .map(([name, value]) => `${name}:${value}`);
  const links = list(look?.stylesheets).map(safeHref).filter(href => href && !href.startsWith('#'))
    .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}"/>`).join('');
  const overrides = list(look?.override_stylesheets).map(safeHref).filter(href => href && !href.startsWith('#'))
    .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}"/>`).join('');
  return links + (entries.length ? `<style>:root{${entries.join(';')}}</style>` : '') + overrides;
}

/** The phone's status bar and the browser's own bar take the page's ground colour (`theme-color`), so a dark look
 *  never sits under a white bar and a light one under a black bar (screen-look browser-chrome-colour.mjs decides it;
 *  the workspace keeps it current when the worn look changes). Nothing is written when the look has no plain ground. */
export function themeColorHtml(look) {
  const ground = browserChromeColour(look?.palette);
  return ground ? `<meta name="theme-color" content="${escapeHtml(ground)}"/>` : '';
}

const META_DESCRIPTION_LIMIT = 160;

/** What a page says about itself to a search or answer engine: its own `meta_description`, else the first words of
 *  the first section that has any, cut at a word. Nothing is written when the page has no words. */
function metaDescriptionHtml(description) {
  const own = textOrNull(description?.meta_description);
  const first = own ?? list(description?.sections).map(section => textOrNull(section?.body)).find(Boolean) ?? '';
  const said = first.length > META_DESCRIPTION_LIMIT ? `${first.slice(0, META_DESCRIPTION_LIMIT).replace(/\s+\S*$/, '')}...` : first;
  return said ? `<meta name="description" content="${escapeHtml(said)}"/>` : '';
}

const dateOf = value => (value && typeof value.iso === 'string' && !Number.isNaN(Date.parse(value.iso)) ? value : null);

/** The dates a page was published and last changed, as `{ published, modified }`, each `{ label, iso, text }`: the
 *  meta tags engines read them from. */
function pageDatesMetaHtml(dates) {
  return [['article:published_time', dateOf(dates?.published)], ['article:modified_time', dateOf(dates?.modified)]]
    .filter(([, value]) => value).map(([property, value]) => `<meta property="${property}" content="${escapeHtml(value.iso)}"/>`).join('');
}

/** The same dates where a reader sees them, each in a <time> element: "Published October 3, 2026 · Updated October 5, 2026". */
function pageDatesHtml(dates) {
  const shown = [dateOf(dates?.published), dateOf(dates?.modified)].filter(Boolean)
    .map(value => `${escapeHtml(value.label ?? '')} <time datetime="${escapeHtml(value.iso)}">${escapeHtml(value.text ?? value.iso)}</time>`);
  return shown.length ? `<section class="page-section page-section--fine page-dates"><p class="page-body">${shown.join(' &middot; ')}</p></section>` : '';
}

export function pageShellHtml(description, { stateScripts = '' } = {}) {
  const island = description?.island ?? {};
  // The look decides light or dark (its own ground, as page-look.mjs reads it): the built-in controls and
  // look-bridges.css's html[data-look-scheme] rules follow it on a server page as they do in the workspace.
  const scheme = description?.look?.scheme === 'dark' ? 'dark' : 'light';
  const sections = pageSectionsHtml(description?.sections) + pageDatesHtml(description?.dates);
  // Sections beside the main ones (a reader's side column), in their own landmark.
  const aside = pageSectionsHtml(description?.aside);
  const canonicalUrl = canonicalUrlFor(description, description?.canonical_path ?? '/');
  const layout = wordClass('page-layout', description?.layout);
  const content = aside ? `<div class="page-layout${layout}"><main class="page-main">${sections}</main><aside class="page-aside">${aside}</aside></div>`
    : layout ? `<div class="page-layout${layout}"><main class="page-main">${sections}</main></div>` : sections ? `<main>${sections}</main>` : sections;
  const growing = /data-page-more/.test(sections) ? `<script>${PAGE_MORE_SCRIPT}</script>` : '';
  // A section with `share` draws the shared share row (../share-row); its rules and script come only with it.
  const sharing = /data-share-row/.test(sections + aside);
  const stylesheet = island.stylesheet_url
    ? `<link rel="stylesheet" href="${escapeHtml(island.stylesheet_url)}"/>` : '';
  // A module bundle (`bundle_type: 'module'`) runs deferred as a module; the files it imports before it can run
  // (`preload_urls`) are fetched alongside it rather than after it is read. With `bundle_async` it runs the moment it
  // is loaded, while the rest of the page may still be arriving (the script sits after the mount element, so that
  // element is always there when it runs).
  const moduleBundle = island.bundle_type === 'module';
  const bundle = island.bundle_url
    ? (moduleBundle ? `<script type="module"${island.bundle_async === true ? ' async' : ''} src="${escapeHtml(island.bundle_url)}"></script>` : `<script src="${escapeHtml(island.bundle_url)}" defer></script>`) : '';
  // An import map (`import_map`, { imports }) names what bare module names resolve to, for modules the page imports
  // later; it must come before any module script, so it leads the head's scripts.
  const importMap = moduleBundle && island.import_map && typeof island.import_map === 'object'
    ? `<script type="importmap">${JSON.stringify(island.import_map).replace(/</g, '\\u003c')}</script>` : '';
  const preloads = moduleBundle ? list(island.preload_urls).map(safeHref).filter(href => href && !href.startsWith('#'))
    .map(href => `<link rel="modulepreload" href="${escapeHtml(href)}"/>`).join('') : '';
  // A page that can already be read has nowhere better to send a reader
  // without scripting, so the redirect is only emitted when the page would
  // otherwise be empty.
  const noscript = island.noscript_route && !sections
    ? `<noscript><meta http-equiv="refresh" content="0;url=${escapeHtml(island.noscript_route)}"/></noscript>` : '';
  return `<!doctype html><html lang="${escapeHtml(description?.language ?? 'en')}"`
    + ` data-theme="${escapeHtml(description?.theme ?? 'paper')}" data-look-scheme="${scheme}"><head>`
    + '<meta charset="utf-8"/>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + `<meta name="color-scheme" content="${scheme}"/>`
    + themeColorHtml(description?.look)
    + `<title>${escapeHtml(description?.title ?? '')}</title>`
    + metaDescriptionHtml(description)
    + pageDatesMetaHtml(description?.dates)
    + (canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}"/>` : '')
    + (textOrNull(description?.robots) && /^[a-z, -]+$/.test(description.robots) ? `<meta name="robots" content="${escapeHtml(description.robots)}"/>` : '')
    + shareMetaHtml(description?.share)
    + jsonLdHtml(description?.structured_data)
    + iconLinksHtml(description?.icons)
    + lookHtml(description?.look)
    + importMap
    + stylesheet
    + preloads
    + `<style>${island.inline_css ?? 'html,body{margin:0;padding:0}'}</style>`
    + (sections ? `<style>${PAGE_SECTIONS_CSS}${layout || aside || /page-card|page-chip/.test(sections) ? PAGE_BROWSE_CSS : ''}${sections.includes('trillion-plan-card') ? PLAN_CARD_CSS : ''}${PAGE_WORK_CSS}${/class="page-prose"/.test(sections + aside) ? PAGE_PROSE_CSS : ''}${sharing ? PAGE_SHARE_CSS + SHARE_ROW_CSS : ''}</style>` : '')
    + `</head><body>${stateScripts}`
    // `opening_cover`: the page opens under the thread cover (../thread-cover), drawn from these first bytes, opaque over
    // the whole window until the page's script lifts it (`window.trillionCover.lift()`).
    + (description?.opening_cover === true ? threadCoverHtml() : '')
    // `reload_on_insert`: content that makes whoever inserts it into a live page load the address again. A browser
    // acts on a refresh pragma when the element enters the document, so an earlier copy of the page that repaints
    // itself by copying this root reloads into the current one instead of painting an empty root.
    + `<div id="${escapeHtml(island.mount_element_id ?? 'root')}">${description?.reload_on_insert === true ? '<meta http-equiv="refresh" content="0"/>' : ''}${content}</div>`
    + growing
    + (sharing ? `<script>${SHARE_ROW_SCRIPT}</script>` : '')
    + (/data-page-reveal/.test(sections + aside) ? `<script>${PAGE_REVEAL_SCRIPT}</script>` : '')
    + (/data-page-code/.test(sections + aside) ? `<script>${PAGE_CODE_SCRIPT}</script>` : '')
    + (/data-page-close/.test(sections + aside) ? `<script>${PAGE_CLOSE_SCRIPT}</script>` : '')
    + (/data-picture-source|data-page-more/.test(sections + aside) ? `<script>${PICTURE_READINESS_SCRIPT}</script>` : '')
    + bundle
    + noscript
    + '</body></html>';
}

// Typography with room to breathe. Long copy is allowed to take more lines;
// nothing here tightens letter spacing or line height to fit more words into
// fewer of them, because that is how a page ends up technically containing its
// message and being unreadable.
// The share row's colour roles, read from this page's own roles.
const PAGE_SHARE_CSS = `:root{--share-ink:var(--page-ink);--share-muted:var(--page-soft);--share-line:var(--page-line-strong);--share-fill:var(--page-card);--share-strong:var(--page-accent);--share-on-strong:var(--page-accent-text);--share-focus:var(--page-focus)}`;

export const PAGE_SECTIONS_CSS = `
:root{--page-bg:var(--bg-primary);--page-card:var(--bg-surface);--page-ink:var(--text-primary);
--page-soft:var(--text-secondary);--page-faint:var(--text-muted);--page-line:var(--border-primary);
--page-line-strong:var(--border-secondary);--page-tint:var(--glass-bg-subtle);
--page-good:var(--color-success);--page-bad:var(--color-error);--page-warn:var(--color-warning);--page-accent:var(--button-primary-bg);--page-accent-text:var(--button-primary-text);
--page-accent-deep:var(--button-primary-bg-hover);--page-focus:var(--border-focus);
--page-radius:var(--radius-card);--page-radius-control:var(--radius-control);
--page-font:var(--font-primary);
--page-display:var(--font-display);
--page-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 4%,transparent),0 28px 64px -36px color-mix(in srgb,var(--text-primary) 32%,transparent);
--page-card-hover:color-mix(in srgb,var(--page-card) 94%,var(--page-ink));--page-line-hover:color-mix(in srgb,var(--page-line-strong) 60%,var(--page-ink))}
html,body{margin:0;padding:0;background:var(--page-bg);color:var(--page-ink)}
body{font-family:var(--page-font);line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.page-section{max-width:46rem;margin:0 auto;padding:5rem 1.5rem;border-bottom:1px solid var(--page-line)}
.page-section:last-child{border-bottom:0}
.page-heading{margin:0 0 1.25rem;font-family:var(--page-display);font-size:2rem;line-height:1.25;font-weight:500;color:var(--page-ink)}
.page-body{margin:0;font-size:1.125rem;color:var(--page-soft);max-width:38rem}
.page-illustration{display:block;width:auto;max-width:100%;height:10rem;margin:0 0 1.75rem;object-fit:contain}
.page-media{display:block;width:100%;max-height:70vh;margin:2rem 0 0;border-radius:var(--page-radius);background:var(--page-ink)}
.page-view{display:block;width:100%;min-height:20rem;margin:1.5rem 0 0;--color-foreground:var(--page-ink);--color-muted-foreground:var(--page-soft);--color-card:var(--page-card);--color-border:var(--page-line);--color-ring:var(--page-focus)}
.page-media-player{aspect-ratio:16/9;overflow:hidden;display:grid;place-items:center;color:var(--page-bg)}
.page-media-player:has([data-media-playback-surface]){height:auto;aspect-ratio:auto;display:block;background:transparent;overflow:visible}
.page-media-fallback{color:inherit;text-decoration:none}
.page-media-fallback:hover{text-decoration:underline}
.page-media-frame{height:var(--page-frame-height,720px);max-height:none;border:1px solid var(--page-line);background:var(--page-bg)}

.page-section--live{max-width:80rem}
@media (max-width:640px){.page-section--live{padding-left:.5rem;padding-right:.5rem}.page-media-frame{height:var(--page-frame-phone-height,640px)}}
.page-action-mark{width:1.5rem;height:1.5rem;flex:none;border-radius:var(--radius-chip);object-fit:contain}
.page-items{margin:2.5rem 0 0;padding:0;list-style:none;display:grid;gap:2rem}
.page-item-heading{margin:0 0 .5rem;font-size:1.0625rem;font-weight:600}
.page-item-body{margin:0;color:var(--page-soft)}
.page-actions{margin-top:2.5rem;display:flex;flex-wrap:wrap;gap:.75rem}
.page-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.875rem;
padding:.7rem 1.35rem;border:1px solid transparent;border-radius:var(--page-radius-control);background-color:var(--page-accent);background-image:var(--button-sheen,none);
color:var(--page-accent-text);font:inherit;font-size:1rem;font-weight:600;line-height:1.25;text-decoration:none;
box-shadow:var(--button-highlight),var(--button-shadow);transition:background-color .15s,border-color .15s,transform .15s}
.page-action:hover{background-color:var(--page-accent-deep)}
.page-action:active{transform:scale(var(--button-pressed-scale));box-shadow:var(--button-pressed-highlight)}
.page-action-form{display:contents}
.page-chip-mark{width:1.125rem;height:1.125rem;flex:none;border-radius:.3rem;object-fit:contain}
button.page-action{cursor:pointer}
.page-action--quiet{background:var(--page-card);color:var(--page-ink);border-color:var(--page-line-strong);box-shadow:none}
.page-action--quiet:hover{background:var(--page-card-hover);border-color:var(--page-line-hover)}
.page-section--hero{padding-top:7rem;padding-bottom:6rem}
.page-section--hero .page-heading{font-size:3rem;line-height:1.15}
.page-section--hero .page-body{font-size:1.25rem;color:var(--page-ink)}
@media(min-width:48rem){.page-items{grid-template-columns:1fr 1fr;gap:2rem 2.5rem}}
.page-item-top{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.page-item-meta{flex:none;display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .6rem;border:1px solid var(--page-line);
border-radius:999px;font-size:.8125rem;color:var(--page-soft);background:var(--page-card);white-space:nowrap}
.page-item-meta::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:currentColor;opacity:.7}
.page-item-meta--attention{color:var(--page-warn);border-color:color-mix(in srgb,var(--page-warn) 30%,transparent);background:color-mix(in srgb,var(--page-warn) 10%,transparent)}
.page-item-meta--good{color:var(--page-good);border-color:color-mix(in srgb,var(--page-good) 30%,transparent);background:color-mix(in srgb,var(--page-good) 10%,transparent)}
.page-item-meta--quiet{color:var(--page-soft)}
.page-item-detail{margin:.35rem 0 0;color:var(--page-soft);font-size:.9375rem}
.page-item-actions{margin-top:.9rem;display:flex;flex-wrap:wrap;gap:.6rem}
.page-item-actions .page-action{min-height:0;padding:.45rem .9rem;font-size:.875rem;background:var(--page-card);color:var(--page-ink);
border-color:var(--page-line-strong);box-shadow:none}
.page-item-actions .page-action:hover{background:var(--page-card-hover);border-color:var(--page-line-hover)}
.page-fields{display:grid;gap:.9rem}
.page-field{display:grid;gap:.4rem;margin-top:.9rem;text-align:left}
.page-fields .page-field{margin-top:0}
.page-field[hidden],.page-section[hidden]{display:none}
.page-field-label--unseen{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.page-code{display:flex;justify-content:center;gap:.5rem}
.page-code-box{box-sizing:border-box;width:3rem;height:3.5rem;min-width:0;flex:0 1 3rem;padding:0;text-align:center;font:inherit;font-size:1.5rem;font-weight:600;
font-variant-numeric:tabular-nums;color:var(--page-ink);caret-color:var(--page-focus);border:1px solid var(--page-line-strong);border-radius:var(--page-radius-control);
background:var(--page-card);box-shadow:0 1px 2px color-mix(in srgb,var(--page-ink) 4%,transparent);transition:border-color .15s,box-shadow .15s}
.page-code-box:hover{border-color:var(--page-soft)}
.page-code-box:focus{outline:0;border-color:var(--page-focus);box-shadow:0 0 0 3px var(--page-tint),0 0 0 1px var(--page-focus)}
.page-field-hint{margin:0;font-size:.8125rem;line-height:1.4;color:var(--page-soft)}
.page-sent-to{margin:.5rem auto 0;font-size:.9375rem;line-height:1.5;color:var(--page-soft)}
.page-sent-to-address{color:var(--page-ink);font-weight:600;word-break:break-all}
.page-sent-to-change{margin-left:.25rem;color:var(--page-ink);font-weight:500;text-decoration:underline;text-underline-offset:2px}
.page-action[data-page-waiting]{pointer-events:none;color:var(--page-faint)}
.page-work-face{display:inline-flex;align-items:center;justify-content:center;gap:.5em}
.page-section--auth-progress .page-heading .loading-mark{margin-right:.4em;vertical-align:middle}
.page-work-mark{width:1em;height:1em;flex:none}
.page-status[data-page-tone="error"]{color:var(--page-bad);font-weight:500}
.page-field-label{font-size:.875rem;font-weight:500;color:var(--page-ink)}
.page-field-input{box-sizing:border-box;width:100%;min-height:2.875rem;font:inherit;font-size:1rem;color:var(--page-ink);padding:.65rem .85rem;
border:1px solid var(--page-line-strong);border-radius:var(--page-radius-control);background:var(--page-card);
transition:border-color .15s,box-shadow .15s}
textarea.page-field-input{resize:vertical;line-height:1.5}
.page-field-input::placeholder{color:var(--page-faint)}
.page-field-input:hover{border-color:var(--page-soft)}
.page-field-input:focus{outline:0;border-color:var(--page-focus);box-shadow:0 0 0 3px var(--page-tint),0 0 0 1px var(--page-focus)}
.page-field-top{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.page-field-link{font-size:.8125rem;color:var(--page-soft);text-decoration:none}
.page-field-link:hover{color:var(--page-ink);text-decoration:underline}
.page-field-box{position:relative}
.page-field-box .page-field-input{padding-right:2.75rem}
.page-field-reveal{position:absolute;top:50%;right:.3rem;transform:translateY(-50%);display:grid;place-items:center;width:2.25rem;height:2.25rem;
padding:0;border:0;border-radius:.5rem;background:transparent;color:var(--page-soft);cursor:pointer}
.page-field-reveal:hover{color:var(--page-ink);background:var(--page-tint)}
.page-field-reveal:focus-visible{outline:2px solid var(--page-focus);outline-offset:0}
.page-field-reveal svg{grid-area:1/1}
.page-field-reveal .page-reveal-hide,.page-field-reveal[aria-pressed="true"] .page-reveal-show{visibility:hidden}
.page-field-reveal[aria-pressed="true"] .page-reveal-hide{visibility:visible}
.page-divider{display:flex;align-items:center;gap:.75rem;margin:1.5rem 0;color:var(--page-faint);font-size:.6875rem;line-height:1;}
.page-divider::before,.page-divider::after{content:"";flex:1;height:1px;background:var(--page-line)}
.page-prompt{margin:1.5rem 0 0;text-align:center;font-size:.8125rem;color:var(--page-soft)}
.page-prompt-link{color:var(--page-ink);font-weight:600;text-decoration:none}
.page-prompt-link:hover{text-decoration:underline}
.page-action--link{min-height:0;padding:.25rem .5rem;border:0;background:transparent;color:var(--page-soft);font-size:.875rem;font-weight:500;box-shadow:none}
.page-action--link:hover{background:transparent;color:var(--page-ink);text-decoration:underline}
.page-status:empty{margin:0}
.page-action:focus-visible{outline:2px solid var(--page-focus);outline-offset:2px}
.page-section--work{padding:2.5rem 1.5rem}
.page-section--work .page-heading{font-size:1.25rem;margin-bottom:.5rem}
.page-section--work .page-body{font-size:1rem}
.page-section--work .page-items{grid-template-columns:1fr;gap:0;margin-top:1.25rem;border-top:1px solid var(--page-line)}
.page-section--work .page-item{padding:1rem 0;border-bottom:1px solid var(--page-line)}
@media(hover:hover){.page-section--work .page-item-actions{opacity:0;transition:opacity .15s}
.page-section--work .page-item:hover .page-item-actions,.page-section--work .page-item:focus-within .page-item-actions,
.page-section--work .page-item:has(.page-fields) .page-item-actions{opacity:1}}
.page-section--welcome,.page-section--card{box-sizing:border-box;width:calc(100% - 2rem);max-width:27rem;background:var(--page-card);
border:1px solid var(--page-line);border-radius:calc(var(--page-radius) * 1.45);box-shadow:var(--page-shadow)}
.page-section--welcome{margin:clamp(1.5rem,9vh,5.5rem) auto 2rem;padding:2.25rem 2rem 2rem;text-align:center}
.page-section--welcome:last-child{margin-bottom:clamp(1.5rem,9vh,5.5rem)}
.page-section--welcome .page-illustration{height:9rem;margin:-.25rem auto 1.5rem}
.page-section--welcome .page-heading{font-size:1.875rem;line-height:1.2;margin-bottom:.6rem}
.page-section--welcome .page-body{margin:0 auto;font-size:1rem}
.page-section--welcome .page-items{grid-template-columns:1fr;gap:1rem;margin-top:1.75rem;text-align:left;padding:1.1rem 1.2rem;
border-radius:var(--page-radius);background:var(--page-tint)}
.page-section--welcome .page-item-heading{font-size:.9375rem;margin-bottom:.15rem}
.page-section--welcome .page-item-body{font-size:.875rem;line-height:1.55}
.page-section--welcome .page-fields{margin-top:1.5rem}
.page-section--welcome .page-actions{flex-direction:column;align-items:stretch;gap:.6rem;margin-top:1.5rem}
.page-status{margin:1rem 0 0;font-size:.875rem;line-height:1.5;color:var(--page-soft)}
.page-section--welcome .page-status{margin-top:1rem;text-align:left}
.page-section--card{margin:0 auto 1rem;padding:1.5rem 1.6rem 1.4rem}
.page-section--welcome+.page-section--card{margin-top:2.5rem}
.page-section--card .page-heading{font-size:1.3rem;line-height:1.3;margin-bottom:.5rem}
.page-section--card .page-body{font-size:.9375rem;line-height:1.6}
.page-section--card .page-actions{margin-top:1.1rem}
.page-section--card .page-action{min-height:2.5rem;padding:.55rem 1.1rem;font-size:.9375rem;background:var(--page-card);color:var(--page-ink);
border-color:var(--page-line-strong);box-shadow:none}
.page-section--card .page-action:hover{background:var(--page-card-hover);border-color:var(--page-line-hover)}
.page-image{display:block;width:100%;height:auto;margin:2rem 0 0;border-radius:.9rem}
/* Steps in order: a numbered badge on each, joined by one rail down the left, the picture framed like a changelog's. */
.page-steps{position:relative;margin:2.5rem 0 0;padding:0;list-style:none;display:grid;gap:2.25rem}
.page-steps::before{content:"";position:absolute;left:.9375rem;top:1rem;bottom:1rem;width:2px;border-radius:2px;background:var(--page-line)}
.page-step{position:relative;display:grid;grid-template-columns:1.875rem minmax(0,1fr);gap:1rem;align-items:start}
.page-step-number{box-sizing:border-box;position:relative;display:inline-grid;place-items:center;width:1.875rem;height:1.875rem;border-radius:50%;
border:1px solid var(--page-line-strong);background:var(--page-card);color:var(--page-ink);font-size:.875rem;font-weight:600;
font-variant-numeric:tabular-nums;box-shadow:0 0 0 4px var(--page-bg)}
.page-step-heading{margin:.15rem 0 .35rem;font-size:1.125rem;line-height:1.4;font-weight:600;color:var(--page-ink)}
.page-step-body{margin:0;color:var(--page-soft)}
.page-step-image{display:block;width:100%;height:auto;margin:1rem 0 0;border:1px solid var(--page-line);border-radius:var(--page-radius);
background:var(--page-card)}
.page-step-actions{margin-top:1rem;display:flex;flex-wrap:wrap;gap:.6rem}
.page-card .page-image{margin:0;border-radius:1.1rem 1.1rem 0 0}
/* A section's mark (a space's picture or its letters) and who is in it: faces overlap like a stack of cards. */
.page-mark{display:block;box-sizing:border-box;width:4rem;height:4rem;margin:0 0 1.5rem;border-radius:1.1rem;object-fit:cover;
background:var(--page-ink);color:var(--page-bg);font-family:var(--page-display);font-size:1.6rem;line-height:4rem;text-align:center;
box-shadow:0 1px 2px color-mix(in srgb,var(--page-ink) 8%,transparent),0 12px 28px -18px color-mix(in srgb,var(--page-ink) 45%,transparent)}
.page-section--welcome .page-mark{margin:0 auto 1.35rem}
.page-people{display:flex;align-items:center;gap:.75rem;margin-top:1.5rem}
.page-section--welcome .page-people{justify-content:center;flex-direction:column;gap:.6rem}
.page-faces{display:flex;padding-left:.5rem}
.page-face{box-sizing:border-box;display:inline-grid;place-items:center;width:2.25rem;height:2.25rem;margin-left:-.5rem;border-radius:50%;
box-shadow:0 0 0 2px var(--page-card);background:var(--page-bg);color:var(--page-ink);font-size:.75rem;font-weight:600;object-fit:cover}
.page-face{position:relative}.page-face:first-child{z-index:1;background:var(--page-ink);color:var(--page-bg)}
.page-face--more{background:var(--page-bg);color:var(--page-soft)}
.page-people-line{margin:0;font-size:.875rem;color:var(--page-soft)}
.page-section--fine{max-width:27rem;padding:1.25rem 1.5rem 3rem;text-align:center;border:0}
.page-section--welcome+.page-section--fine{padding-top:0;margin-top:-.5rem}
.page-section--fine .page-body{margin:0 auto;font-size:.8125rem;color:var(--page-faint)}
.page-section--fine .page-actions{justify-content:center;gap:.25rem;margin-top:.5rem}
.page-section--fine .page-action{min-height:0;padding:.35rem .7rem;font-size:.8125rem;font-weight:500;background:transparent;color:var(--page-soft);
border:0;box-shadow:none}
.page-section--fine .page-action:hover{color:var(--page-ink);background:transparent;text-decoration:underline}
.page-section--fine .page-action:has(.page-action-mark){font-size:.9375rem;gap:.6rem;text-decoration:none}
.page-section--fine .page-action:has(.page-action-mark):hover{text-decoration:none}
@media(max-width:30rem){.page-section{padding:3.5rem 1.25rem}
.page-section--welcome{margin-top:1rem;padding:1.75rem 1.25rem 1.5rem}
.page-section--welcome .page-illustration{height:7.5rem}
.page-section--welcome .page-heading{font-size:1.625rem}
.page-section--card{padding:1.25rem 1.25rem 1.2rem}}
/* A choice sent as one form: each option is a full-width row whose mark shows whether it is ticked. */
.page-choices{margin-top:1.75rem;display:grid;gap:1.5rem}
.page-choice-group{margin:0;padding:0;border:0;min-width:0;display:grid;gap:.5rem}
.page-choice-legend{padding:0;margin:0 0 .6rem;font-size:.8125rem;font-weight:600;color:var(--page-soft)}
.page-choice{position:relative;display:flex;align-items:center;gap:.85rem;min-height:3.25rem;padding:.7rem 1rem;box-sizing:border-box;
border:1px solid var(--page-line);border-radius:var(--page-radius-control);background:var(--page-card);cursor:pointer;
transition:border-color .15s,background-color .15s}
.page-choice:hover{border-color:var(--page-line-strong)}
.page-choice--nested{margin-inline-start:calc(var(--page-choice-depth) * 1.25rem)}
.page-choice-input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.page-choice-mark{flex:none;box-sizing:border-box;width:1.375rem;height:1.375rem;border:1.5px solid var(--page-line-strong);border-radius:.4rem;
display:grid;place-items:center;transition:background-color .15s,border-color .15s}
.page-choice--radio .page-choice-mark{border-radius:50%}
.page-choice-mark::after{content:"";width:.7rem;height:.7rem;background:var(--page-accent-text);opacity:0;transform:scale(.6);
transition:opacity .15s,transform .15s;-webkit-mask:var(--page-tick) center/contain no-repeat;mask:var(--page-tick) center/contain no-repeat}
.page-choice--radio .page-choice-mark::after{width:.5rem;height:.5rem;border-radius:50%;-webkit-mask:none;mask:none}
:root{--page-tick:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 6.4 4.8 9 10 3' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");}
.page-choice:has(.page-choice-input:checked){border-color:var(--page-accent)}
.page-choice-input:checked+.page-choice-mark{background:var(--page-accent);border-color:var(--page-accent)}
.page-choice-input:checked+.page-choice-mark::after{opacity:1;transform:none}
.page-choice-input:focus-visible+.page-choice-mark{outline:2px solid var(--page-focus);outline-offset:2px}
.page-choice-text{display:grid;gap:.1rem;min-width:0}
.page-choice-label{font-size:1rem;font-weight:500;color:var(--page-ink)}
.page-choice-detail{font-size:.8125rem;color:var(--page-soft)}
.page-choice-more{display:grid;gap:.5rem}
.page-choice-more-line{cursor:pointer;list-style:none;padding:.5rem .25rem;font-size:.875rem;font-weight:600;color:var(--page-soft)}
.page-choice-more-line::-webkit-details-marker{display:none}
.page-choices-send{width:100%;min-height:3.25rem;font-size:1.0625rem}
@media(prefers-reduced-motion:reduce){.page-section--work .page-item-actions,.page-action,.page-field-input,.page-choice,.page-choice-mark,.page-choice-mark::after{transition:none}.page-action:active{transform:none}}
`.trim();

// A growing list: when the reader nears the end of a card grid, the next page
// is fetched, its cards are moved into this grid, and the link now points at
// the page after that. Without scripting the same link opens the next page.
// Cards arrive as nodes adopted from the parsed page, so nothing is written as
// markup here either.
export const PAGE_MORE_SCRIPT = `(() => {
  const more = document.querySelector('[data-page-more]');
  const grid = document.querySelector('[data-page-cards]');
  if (!more || !grid || !('IntersectionObserver' in window)) return;
  let busy = false;
  const load = async () => {
    const href = more.getAttribute('href');
    if (busy || !href) return;
    busy = true;
    more.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(href, { headers: { accept: 'text/html' } });
      if (!response.ok) return;
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      for (const card of [...(page.querySelector('[data-page-cards]')?.children ?? [])]) grid.append(document.adoptNode(card));
      const next = page.querySelector('[data-page-more]')?.getAttribute('href');
      if (next) more.setAttribute('href', next); else { watcher.disconnect(); more.closest('.page-more-row')?.remove(); }
    } finally { busy = false; more.removeAttribute('aria-busy'); }
  };
  const watcher = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); }, { rootMargin: '900px 0px' });
  watcher.observe(more);
  more.addEventListener('click', event => { event.preventDefault(); load(); });
})();
`;

// Browsing and reading: filter chips, a card grid that flows into columns, the
// growing list's link, action tones, and a reader layout with a side column.
// A passage of words (a section's `markdown`): one reading column in the look's own type, with real steps between
// headings, quiet tables and code, pictures in a frame and quotes that hold paragraphs drawn as a tinted card. Sent only
// with a page that holds one. Nothing tightens letter spacing or line height to fit more words.
export const PAGE_PROSE_CSS = `
.page-main:has(>.page-section>.page-prose)>.page-section{max-width:44rem;margin-inline:auto}
.page-prose{max-width:44rem;margin-top:clamp(1.75rem,4vw,2.75rem);font-size:1.0625rem;line-height:1.75;color:var(--page-ink);overflow-wrap:anywhere}
.page-prose>:first-child{margin-top:0}.page-prose>:last-child{margin-bottom:0}
.page-prose .doc-h2{margin:3rem 0 1rem;padding-top:2.25rem;border-top:1px solid var(--page-line);font-family:var(--page-display);font-weight:500;font-size:clamp(1.5rem,2.6vw,1.95rem);line-height:1.25}
.page-prose>.doc-h2:first-child{padding-top:0;border-top:0}
.page-prose .doc-h3{margin:2.25rem 0 .6rem;font-size:1.25rem;line-height:1.35;font-weight:650}
.page-prose .doc-h4{margin:1.75rem 0 .5rem;font-size:1.0625rem;line-height:1.4;font-weight:650}
.page-prose .doc-p{margin:0 0 1.15em}
.page-prose strong{font-weight:650}
.page-prose del{color:var(--page-faint)}
.page-prose .doc-list{margin:0 0 1.3em;padding-left:1.45em}
.page-prose .doc-list li{margin:.4em 0;padding-left:.2em}
.page-prose .doc-list li::marker{color:var(--page-faint)}
.page-prose .doc-task{list-style:none;position:relative;margin-left:-1.45em;padding-left:1.9em}
.page-prose .doc-task-box{position:absolute;left:0;top:.38em;width:1.05em;height:1.05em;box-sizing:border-box;border:1.5px solid var(--page-line-strong);border-radius:.3em}
.page-prose .doc-task[data-done="true"]{color:var(--page-soft)}
.page-prose .doc-task[data-done="true"] .doc-task-box{border-color:var(--page-ink);background:var(--page-ink)}
.page-prose .doc-task[data-done="true"] .doc-task-box::after{content:'';position:absolute;left:.3em;top:.1em;width:.28em;height:.55em;border:solid var(--page-card);border-width:0 .14em .14em 0;transform:rotate(45deg)}
.page-prose .page-prose-link{color:inherit;text-decoration:underline;text-decoration-color:var(--thread-line,var(--page-accent));text-decoration-thickness:1.5px;text-underline-offset:.2em}
.page-prose .page-prose-link:hover{text-decoration-thickness:2.5px}
.page-prose .page-prose-link:focus-visible{outline:2px solid var(--page-focus);outline-offset:2px;border-radius:2px}
.page-prose .doc-quote{margin:2rem 0;font-family:var(--page-display);font-size:1.35em;line-height:1.45;color:var(--page-ink)}
.page-prose .doc-quote--held{margin:1.75rem 0;padding:1.15rem 1.35rem;border-radius:var(--page-radius);background:var(--page-tint);font-family:var(--page-font);font-size:.95em;line-height:1.7;color:var(--page-soft)}
.page-prose .doc-quote--held>:first-child{margin-top:0}.page-prose .doc-quote--held>:last-child{margin-bottom:0}
.page-prose .doc-quote--held .doc-p{margin-bottom:.7em}
.page-prose code{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.875em;padding:.12em .4em;border-radius:.35em;background:var(--page-tint)}
.page-prose .doc-code{margin:1.5rem 0;padding:1rem 1.2rem;border:1px solid var(--page-line);border-radius:.85rem;background:var(--page-card);overflow-x:auto;line-height:1.6;white-space:pre}
.page-prose .doc-code code{padding:0;background:none;font-size:.85rem}
.page-prose .doc-rule{border:0;border-top:1px solid var(--page-line);margin:2.5rem 0}
.page-prose .doc-table-wrap{margin:1.6rem 0;border:1px solid var(--page-line);border-radius:.85rem;overflow-x:auto;background:var(--page-card)}
.page-prose .doc-table{width:100%;border-collapse:collapse;font-size:.9375rem;line-height:1.5;font-variant-numeric:tabular-nums}
.page-prose .doc-table th{padding:.75rem 1rem;text-align:left;font-weight:650;background:var(--page-tint);border-bottom:1px solid var(--page-line);white-space:nowrap}
.page-prose .doc-table td{padding:.7rem 1rem;border-top:1px solid var(--page-line);vertical-align:top}
.page-prose .doc-table tr:first-child td{border-top:0}
.page-prose .doc-table [data-align="right"]{text-align:right}.page-prose .doc-table [data-align="center"]{text-align:center}
.page-prose .doc-img{max-width:100%;height:auto;border-radius:.85rem;vertical-align:middle}
.page-prose .doc-p--picture{margin:1.75rem 0}
.page-prose .doc-p--picture .doc-img{display:block;width:100%;border:1px solid var(--page-line)}
@media (max-width:40rem){.page-prose{font-size:1rem;line-height:1.7}.page-prose .doc-h2{margin-top:2.25rem;padding-top:1.75rem}.page-prose .doc-quote{font-size:1.2em}.page-prose .doc-table{font-size:.875rem}}
`;

export const PAGE_WORK_CSS = `
/* A pressed action's work (page-work.mjs), after every other action look so it wins in every place an action is drawn:
   waiting takes no presses, done is the good colour with a check, failed is the bad colour with a mark. */
.page-layout .page-action[data-page-work]{pointer-events:none;display:inline-flex;align-items:center;justify-content:center}
.page-layout .page-action[data-page-work="pending"]{cursor:progress}
.page-layout .page-section .page-action[data-page-work="done"]{background:var(--page-good);border-color:var(--page-good);color:var(--page-bg)}
.page-layout .page-section .page-action--quiet[data-page-work="done"],.page-layout .page-section--card .page-action[data-page-work="done"],.page-layout .page-item-actions .page-action[data-page-work="done"]{background:var(--page-card);border-color:var(--page-good);color:var(--page-good)}
.page-layout .page-section .page-action--link[data-page-work="done"],.page-layout .page-section--fine .page-action[data-page-work="done"]{background:transparent;border-color:transparent;color:var(--page-good)}
.page-layout .page-section .page-action[data-page-work="error"],.page-layout .page-section--card .page-action[data-page-work="error"]{background:var(--page-card);border-color:var(--page-bad);color:var(--page-bad)}
.page-layout .page-section .page-action--link[data-page-work="error"],.page-layout .page-section--fine .page-action[data-page-work="error"]{background:transparent;border-color:transparent;color:var(--page-bad)}
`.trim();

export const PAGE_BROWSE_CSS = `
.page-layout{max-width:76rem;margin:0 auto;padding:0 1.5rem}
.page-layout .page-section{max-width:none;margin:0;padding-left:0;padding-right:0}
/* Auth is a single focused passkey page. */
.page-layout--auth{box-sizing:border-box;max-width:none;min-height:100dvh;padding:clamp(3rem,10vh,6rem) 1.5rem;display:flex;justify-content:center;align-items:flex-start}
.page-layout--auth .page-main{width:100%;max-width:24rem;min-width:0;display:flex;flex-direction:column}
.page-layout--auth .page-section{box-sizing:border-box;width:100%;max-width:none;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;background:transparent}
.page-layout--auth .page-section--welcome{text-align:center}
.page-layout--auth .page-section--welcome .page-mark{width:2.5rem;height:2.5rem;margin:0 auto 1.25rem;border-radius:.7rem}
.page-layout--auth .page-section--welcome .page-heading{font-size:1.625rem;line-height:1.25;font-weight:600;margin:0}
.page-layout--auth .page-section--welcome .page-body{margin:.5rem auto 0;max-width:22rem;font-size:.9375rem;line-height:1.5}
.page-layout--auth .page-section--welcome .page-image{max-width:14rem;margin:1.5rem auto 0}
.page-layout--auth .page-choices{margin-top:1.75rem;gap:0;text-align:left}
.page-layout--auth .page-section .page-fields{margin-top:1.75rem;gap:1rem;text-align:left}
.page-layout--auth .page-choices .page-fields{margin-top:0}
.page-layout--auth .page-choices-send{width:100%;min-height:2.75rem;margin-top:1.5rem;font-size:.9375rem;border-radius:var(--radius-control)}
.page-layout--auth .page-field-label{font-size:.8125rem}
.page-layout--auth .page-field-input{min-height:2.75rem;border-radius:var(--radius-control)}
.page-layout--auth .page-section .page-actions{flex-direction:column;align-items:stretch;gap:.75rem;margin-top:1rem}
.page-layout--auth .page-choices+.page-divider+.page-actions,.page-layout--auth .page-divider+.page-actions{margin-top:0}
.page-layout--auth .page-section .page-action{min-height:2.75rem;font-size:.9375rem;border-radius:var(--radius-control)}
.page-layout--auth .page-section .page-action--link{min-height:0;align-self:center;font-size:.875rem}
.page-layout--auth .page-section--fine .page-action--link{font-size:.8125rem;color:var(--page-faint)}
.page-layout--auth .page-section--welcome .page-status{text-align:center;font-size:.8125rem}
.page-layout--auth .page-section--welcome .page-chips{display:grid;grid-template-columns:1fr;gap:0;margin:1.5rem 0 0;padding:0;border:1px solid var(--page-line-strong);border-radius:.75rem;overflow:hidden}
.page-layout--auth .page-section--welcome .page-chip{box-sizing:border-box;width:100%;min-height:2.75rem;justify-content:flex-start;padding:.65rem 1rem;border:0;border-radius:0;background:var(--page-card);font-size:.875rem;line-height:1.35;text-align:left}
.page-layout--auth .page-section--welcome .page-chip+.page-chip{border-top:1px solid var(--page-line)}
.page-layout--auth .page-section--welcome .page-chip::before{content:"";box-sizing:border-box;flex:none;width:1rem;height:1rem;border:1.5px solid var(--page-soft);border-radius:50%}
.page-layout--auth .page-section--welcome .page-chip--selected{background:var(--page-bg);color:var(--page-ink);font-weight:600}
.page-layout--auth .page-section--welcome .page-chip--selected::before{border:5px solid var(--page-ink)}
.page-layout--auth .page-section--welcome .page-chip:hover{background:var(--page-bg)}
.page-layout--auth .page-section--welcome .page-chip:focus-visible{position:relative;outline:2px solid var(--page-focus);outline-offset:-2px}
.page-layout--auth .page-section--card{margin-top:1.75rem;padding-top:1.75rem;border-top:1px solid var(--page-line);text-align:left}
.page-layout--auth .page-section--card .page-heading{font-size:1rem;font-weight:600;margin:0 0 .35rem}
.page-layout--auth .page-section--card .page-body{font-size:.875rem;line-height:1.55;overflow-wrap:anywhere}
.page-layout--auth .page-section--card .page-fields{margin-top:0}
.page-layout--auth .page-section--card .page-action:not(.page-action--link){background:var(--page-accent);color:var(--page-accent-text);border-color:transparent}
.page-layout--auth .page-section--card .page-status{text-align:center;font-size:.8125rem}
.page-layout--auth .page-section--fine{margin-top:2rem;text-align:center}
.page-layout--auth .page-section--fine .page-fields{margin-top:0}
.page-layout--auth .page-section--fine .page-actions{flex-direction:row;flex-wrap:wrap;justify-content:center;gap:.25rem 1rem;margin-top:.75rem}
.page-layout--auth .page-section--fine .page-action--quiet{flex:1 1 100%;background:var(--page-card);color:var(--page-ink);border:1px solid var(--page-line-strong)}
.page-layout--auth .page-section--fine:has(.page-fields){padding-top:1.75rem;border-top:1px solid var(--page-line);text-align:left}
.page-layout--auth .page-chips+.page-choices{margin-top:1.5rem}
.page-section--auth-progress,.page-section--auth-connected{display:none}
html[data-auth-state] .page-main>.page-section{display:none}
html[data-auth-state="returning"] .page-main>.page-section--auth-progress,html[data-auth-state="connected"] .page-main>.page-section--auth-connected{display:block}
.page-layout--auth .page-section--auth-progress,.page-layout--auth .page-section--auth-connected{text-align:center}
.page-section--auth-connected .page-illustration{height:6rem;margin:0 0 1.75rem}
.page-section--auth-progress .page-heading,.page-section--auth-connected .page-heading{font-size:1.625rem;line-height:1.25;font-weight:600;margin-bottom:.5rem}
.page-section--auth-connected .page-actions{gap:.75rem;margin-top:2rem}
.page-section--auth-connected .page-action{min-height:3.4rem}
@media(max-width:30rem){.page-layout--auth{padding-top:2.5rem}}
.page-layout--browse .page-section{border-bottom:0;padding:3rem 0}
.page-layout--browse .page-section--hero{padding:6rem 0 1.5rem}
.page-layout--browse .page-section--hero .page-heading{font-size:clamp(2.5rem,6vw,4.25rem);line-height:1.08;max-width:14ch}
.page-layout--browse .page-section--hero .page-body{max-width:40rem;color:var(--page-soft)}
.page-chips{display:flex;gap:.5rem;overflow-x:auto;padding:.25rem 0 .5rem;margin-top:2rem;scrollbar-width:none}
.page-chips::-webkit-scrollbar{display:none}
/* In a centred opening section the chips are a choice to read whole, so they wrap instead of scrolling. */
.page-section--welcome .page-chips{flex-wrap:wrap;justify-content:center;overflow:visible}
.page-actions+.page-divider+.page-chips{flex-wrap:wrap;justify-content:center;overflow:visible;margin-top:0}
.page-chip{flex:none;display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border:1px solid var(--page-line);border-radius:999px;
background:var(--page-card);color:var(--page-ink);text-decoration:none;font-size:.9375rem;transition:border-color .15s,background .15s,color .15s}
.page-chip:hover{border-color:var(--page-ink)}
.page-chip--selected{background:var(--page-ink);border-color:var(--page-ink);color:var(--page-bg)}
.page-chip-count{font-size:.75rem;padding:.05rem .45rem;border-radius:999px;background:var(--page-bg);color:var(--page-soft);border:1px solid var(--page-line)}
.page-chip--selected .page-chip-count{background:transparent;color:inherit;border-color:color-mix(in srgb,var(--page-bg) 35%,transparent)}
.page-cards{list-style:none;margin:2rem 0 0;padding:0;columns:1;column-gap:1.25rem}
@media(min-width:40rem){.page-cards{columns:2}}
@media(min-width:64rem){.page-cards{columns:3}}
.page-card{break-inside:avoid;margin:0 0 1.25rem;background:var(--page-card);border:1px solid var(--page-line);border-radius:1.1rem;
transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}
.page-card:hover{transform:translateY(-2px);border-color:var(--page-line-hover);box-shadow:0 18px 40px -24px color-mix(in srgb,var(--page-ink) 35%,transparent)}
.page-card-link{display:block;padding:1.5rem 1.5rem 1.35rem;color:inherit;text-decoration:none;border-radius:inherit}
.page-card:not(:has(>.page-card-link)){padding:1.5rem 1.5rem 1.35rem}
.page-card-link:focus-visible{outline:2px solid var(--page-accent);outline-offset:3px}
.page-card-heading{margin:0 0 .6rem;font-size:1.4rem;line-height:1.25;color:var(--page-ink)}
.page-card-body{margin:0;color:var(--page-soft);font-size:.975rem;line-height:1.6}
.page-card-detail{margin:.9rem 0 0;padding-top:.9rem;border-top:1px dashed var(--page-line);font-size:.9rem;color:var(--page-ink)}
.page-card-foot{margin-top:1rem;display:flex;flex-wrap:wrap;gap:.5rem}
.page-card--invite{background:var(--page-ink);border-color:var(--page-ink)}
.page-card--invite .page-card-heading{color:var(--page-bg)}
.page-card--invite .page-card-body{color:color-mix(in srgb,var(--page-bg) 72%,transparent)}
.page-more-row{display:flex;justify-content:center;margin:1.5rem 0 0}
.page-more{padding:.75rem 1.4rem;border:1px solid var(--page-line);border-radius:999px;background:var(--page-card);color:var(--page-ink);text-decoration:none}
.page-more[aria-busy="true"]{opacity:.6}
.page-action--primary{background:var(--page-accent);color:var(--page-accent-text)}
.page-action--primary:hover{background:var(--page-accent-deep)}
.page-section--invite{margin:2rem 0 4rem;padding:3.5rem 2.5rem!important;border-radius:1.5rem;background:var(--page-ink);color:var(--page-bg)}
.page-section--invite .page-heading{color:var(--page-bg);font-size:clamp(1.75rem,3.5vw,2.5rem)}
.page-section--invite .page-body{color:color-mix(in srgb,var(--page-bg) 72%,transparent)}
.page-section--invite .page-action--quiet{color:var(--page-bg);border-color:color-mix(in srgb,var(--page-bg) 30%,transparent)}
.page-layout--reader{display:grid;gap:3rem;padding-top:3.5rem;padding-bottom:5rem}
@media(min-width:64rem){.page-layout--reader{grid-template-columns:minmax(0,1fr) 21rem;gap:4.5rem}
.page-aside{position:sticky;top:2rem;align-self:start}}
.page-layout--reader .page-main{max-width:44rem}
.page-layout--reader .page-section{padding:0 0 2.25rem;border-bottom:0}
.page-layout--reader .page-section .page-heading{font-size:1.35rem;margin-bottom:.75rem}
.page-layout--reader .page-body{font-size:1.0625rem;color:var(--page-ink);max-width:none;line-height:1.75}
.page-layout--reader .page-section--story{padding-bottom:2.75rem;margin-bottom:2.25rem;border-bottom:1px solid var(--page-line)}
.page-layout--reader .page-section--story .page-heading{font-size:clamp(2.25rem,5vw,3.25rem);line-height:1.1}
.page-layout--reader .page-section--story .page-body{font-size:1.25rem;color:var(--page-ink);font-family:var(--page-display)}
.page-layout--reader .page-items{grid-template-columns:1fr;gap:.6rem;margin-top:1rem}
.page-layout--reader .page-item{padding:.9rem 1.1rem;border:1px solid var(--page-line);border-radius:.8rem;background:var(--page-card)}
.page-layout--reader .page-item-heading{margin:0;font-weight:500;font-size:1rem}
.page-layout--reader .page-item-detail{font-size:1rem;color:var(--page-ink)}
.page-layout .page-section--fine .page-body{font-size:.875rem;color:var(--page-soft)}
.page-layout .page-section--invite .page-body{color:color-mix(in srgb,var(--page-bg) 72%,transparent)}
.page-aside .page-section{padding:0 0 1.5rem;border:0}
.page-aside .page-section--invite{margin:0 0 2rem;padding:2rem 1.75rem!important;border-radius:1.25rem}
.page-layout .page-aside .page-section--invite .page-heading{font-size:1.6rem;line-height:1.2}
.page-aside .page-actions{margin-top:1.5rem;flex-direction:column}
.page-aside .page-action{text-align:center}
.page-aside .page-cards{columns:1;margin-top:1rem}
.page-aside .page-card-link{padding:1.1rem 1.2rem}
.page-aside .page-card-heading{font-size:1.1rem}
.page-aside .page-section:not(.page-section--invite) .page-heading{font-size:1rem;font-family:inherit;font-weight:600}
/* A sheet: one narrow column for a short task on a phone, such as choosing where something goes. */
.page-layout--sheet{box-sizing:border-box;max-width:30rem;padding:1.25rem 1.25rem 2.5rem}
.page-layout--sheet .page-section{padding:.75rem 0;border:0}
.page-layout--sheet .page-heading{font-size:1.75rem;line-height:1.2;margin-bottom:.5rem}
.page-layout--sheet .page-body{font-size:1rem}
.page-layout--sheet .page-cards{columns:1;margin-top:0}
.page-layout--auth .page-cards{columns:1;margin-top:1rem}
.page-layout--auth .page-section:has(.page-cards){margin-top:2.75rem;padding-top:2rem;border-top:1px solid var(--page-line)}
.page-layout--sheet{--share-strong:var(--page-card);--share-on-strong:var(--page-ink)}
.page-layout--sheet .share-row{margin-top:.25rem}
.page-layout--sheet .share-row__label{display:none}
.page-layout--sheet .page-actions{margin-top:.75rem}
.page-layout--sheet .page-choices{margin-top:.5rem}
.page-layout--sheet .page-choices-send{position:sticky;bottom:1rem;box-shadow:0 1rem 0 1rem var(--page-bg),0 -.5rem .75rem 0 var(--page-bg)}
.page-layout--sheet .page-section:only-child{padding-top:30vh}
.page-layout--sheet .page-section:only-child .page-action{width:100%}
.page-card--preview{overflow:hidden;border-radius:var(--page-radius)}
.page-card--preview:hover{transform:none;box-shadow:none;border-color:var(--page-line-strong)}
.page-card--preview .page-image{width:100%;max-height:13rem;object-fit:cover;border-radius:0;background:var(--page-tint)}
.page-card--preview .page-card-link{padding:0}
.page-card--preview .page-card-heading{margin:1rem 1.1rem .35rem;font-family:var(--page-font);font-size:1.0625rem;font-weight:600;line-height:1.35;
display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.page-card--preview .page-card-body{margin:0 1.1rem;font-size:.875rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.page-card--preview .page-card-detail{margin:.5rem 1.1rem 0;padding-top:.5rem;font-size:.8125rem;color:var(--page-soft)}
.page-card--preview .page-card-link>:last-child,.page-card--preview>:last-child{margin-bottom:1.1rem}
@media(prefers-reduced-motion:reduce){.page-card,.page-chip{transition:none}.page-card:hover{transform:none}}
`.trim();
