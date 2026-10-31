// tools/walk-through-an-app-like-its-users/do-work/in-page.mjs
//
// What runs inside the page: these functions are sent to the browser as their own source text and called there with
// one JSON argument. They read the page and act on one element; they never judge (judging is in walk.mjs).
//
// Invariants:
//   - Each function uses only its argument and the page's own globals; nothing from this module's scope.
//   - The controls a read found are kept on the page under one Symbol.for key, so a later action names a control by
//     its index in that read and never by a selector string the page could match differently.

/** Every visible control a person could use: its role, accessible name, value and box, kept for later actions by index. */
export function readControls({ selector, implicit_roles: implicitRoles, most }) {
  const key = Symbol.for('walk-through-an-app.controls');
  const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = element => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    if (element.isContentEditable) return 'textbox';
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    const row = implicitRoles.find(item => item.tag === tag && (item.type === undefined || item.type === type));
    return row ? row.role : tag;
  };
  const byIds = ids => clean(ids.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
  const nameOf = element => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy && byIds(labelledBy)) return byIds(labelledBy);
    if (clean(element.getAttribute('aria-label'))) return clean(element.getAttribute('aria-label'));
    if (element.labels?.length) return clean([...element.labels].map(label => label.innerText).join(' '));
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(element.type)) return clean(element.value) || clean(element.type);
    if (tag === 'input' && element.type === 'image') return clean(element.alt);
    if (['a', 'button', 'summary'].includes(tag) || element.getAttribute('role')) {
      const text = clean(element.innerText);
      if (text) return text;
      const picture = element.querySelector('img[alt], svg[aria-label]');
      if (picture) return clean(picture.getAttribute('alt') ?? picture.getAttribute('aria-label'));
    }
    return clean(element.getAttribute('title')) || clean(element.getAttribute('placeholder'));
  };
  const shown = element => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const found = [...document.querySelectorAll(selector)].filter(shown).slice(0, most);
  globalThis[key] = found;
  return found.map((element, index) => {
    const box = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const fillable = tag === 'input' || tag === 'textarea' || tag === 'select';
    return {
      index,
      role: roleOf(element),
      name: nameOf(element),
      tag,
      ...(fillable && element.type !== 'file' ? { value: tag === 'select' ? clean(element.selectedOptions[0]?.textContent) : element.value } : {}),
      ...(element.type === 'checkbox' || element.type === 'radio' ? { checked: element.checked } : {}),
      ...(element.disabled || element.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
      ...(tag === 'a' ? { href: element.href } : {}),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
}

/** Scrolls one kept control into view and answers its centre in the window, or null when it is gone. */
export function centreOf({ index }) {
  const element = globalThis[Symbol.for('walk-through-an-app.controls')]?.[index];
  if (!element || !element.isConnected) return null;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const box = element.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
}

/**
 * Gets one kept control ready for typed text: a select takes the option whose words or value equal `value` (answers
 * 'chosen'); any other control is focused with its text selected, so typing replaces it (answers 'focused').
 */
export function prepareFill({ index, value }) {
  const element = globalThis[Symbol.for('walk-through-an-app.controls')]?.[index];
  if (!element || !element.isConnected) return 'gone';
  if (element.tagName.toLowerCase() === 'select') {
    const option = [...element.options].find(item => item.textContent.trim() === value || item.value === value);
    if (!option) return 'no-option';
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return 'chosen';
  }
  element.focus();
  if (typeof element.select === 'function') element.select();
  else if (element.isContentEditable) document.getSelection().selectAllChildren(element);
  return 'focused';
}

/** The kept control itself (asked for by reference, for DevTools calls that take an element). */
export function controlAt({ index }) {
  return globalThis[Symbol.for('walk-through-an-app.controls')]?.[index] ?? null;
}

/** Draws a numbered box over `box` for the next picture; `remove` takes it away again. */
export function markBox({ box, label, remove }) {
  const key = Symbol.for('walk-through-an-app.mark');
  globalThis[key]?.remove();
  globalThis[key] = null;
  if (remove || !box) return true;
  const mark = document.createElement('div');
  mark.setAttribute('aria-hidden', 'true');
  Object.assign(mark.style, {
    position: 'fixed', left: `${box.x - 3}px`, top: `${box.y - 3}px`, width: `${box.width + 6}px`, height: `${box.height + 6}px`,
    border: '3px solid #e5484d', borderRadius: '4px', zIndex: '2147483647', pointerEvents: 'none', boxSizing: 'border-box',
  });
  const tag = document.createElement('div');
  tag.textContent = label;
  Object.assign(tag.style, {
    position: 'absolute', left: '-3px', top: '-22px', background: '#e5484d', color: '#fff', font: '600 12px/18px system-ui, sans-serif',
    padding: '0 6px', borderRadius: '3px',
  });
  mark.append(tag);
  document.documentElement.append(mark);
  globalThis[key] = mark;
  return true;
}

/** What a person sees: the address, the title, the visible words and the headings. */
export function readScreen({ most_links: mostLinks }) {
  const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();
  return {
    url: location.href,
    title: document.title,
    text: document.body?.innerText ?? '',
    headings: [...document.querySelectorAll('h1, h2, h3')].map(heading => ({ level: Number(heading.tagName[1]), text: clean(heading.innerText) })).filter(heading => heading.text),
    links: [...new Set([...document.querySelectorAll('a[href]')].map(link => link.href.split('#')[0]))].slice(0, mostLinks),
  };
}

/**
 * Every element matching `selector` (at most `limit`), with what a person or a pointer meets there: its look (cursor,
 * stacking, opacity), its box, and what a pointer aimed at its own centre would land on. `pointer_is_self` is the
 * fact that tells "the control is missing" from "the control is there and something covers it".
 */
export function readElements({ selector, limit }) {
  return [...document.querySelectorAll(selector)].slice(0, limit).map((node, index) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      index,
      tag: node.tagName.toLowerCase(),
      label: node.getAttribute('aria-label') || node.getAttribute('name') || (node.textContent || '').trim().slice(0, 80),
      visible: Boolean(node.offsetWidth || node.offsetHeight),
      disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
      cursor: style.cursor,
      pointer_events: style.pointerEvents,
      z_index: style.zIndex,
      position: style.position,
      opacity: style.opacity,
      rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      pointer_would_hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? `[${hit.getAttribute('aria-label')}]` : '') : null,
      pointer_is_self: hit ? node.contains(hit) : false,
    };
  });
}

/** How many nodes match, and nothing else. */
export function readCount({ selector }) {
  return document.querySelectorAll(selector).length;
}

/** Milliseconds until a media element reports it can play, or that it never did within `timeout_ms`. */
export async function readMediaReady({ selector, timeout_ms: timeoutMs }) {
  const media = document.querySelector(selector);
  if (!media) return { found: false };
  if (media.readyState >= 3) return { found: true, ms: 0, ready_state: media.readyState };
  const started = performance.now();
  const reached = await new Promise(done => {
    media.addEventListener('canplay', () => done(true), { once: true });
    setTimeout(() => done(false), timeoutMs);
  });
  return { found: true, ms: Math.round(performance.now() - started), reached_canplay: reached, ready_state: media.readyState };
}

/** Whether a dotted path exists on `window` and what kind of thing it is. A walk along names, never an evaluation. */
export function readGlobalPath({ path }) {
  let node = window;
  const walked = [];
  for (const key of String(path).split('.')) {
    if (node === null || node === undefined) return { found: false, walked, missing: key };
    node = node[key];
    walked.push(key);
  }
  return { found: node !== undefined, walked, type: typeof node };
}

/** Named attributes and the form value off matched elements (a label alone cannot say which option a dropdown holds). */
export function readAttributes({ selector, names, limit }) {
  return [...document.querySelectorAll(selector)].slice(0, limit).map(node => {
    const row = { tag: node.tagName.toLowerCase(), value: node.value ?? null, children: node.childElementCount };
    for (const name of names) row[name] = node.getAttribute(name);
    return row;
  });
}

/** The words in the first element matching `selector`, or null when none matches. */
export function readText({ selector, most }) {
  const node = document.querySelector(selector);
  return node ? (node.textContent || '').trim().slice(0, most) : null;
}
