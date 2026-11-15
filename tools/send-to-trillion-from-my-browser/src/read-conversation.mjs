// extension/src/read-conversation.mjs
//
// PURPOSE
//   Reads the one conversation open on a chat page (ChatGPT, Gemini, WhatsApp, and any site given a row in
//   extension/conversation-sites.json) into the shape bring_in_chat keeps: { app, conversation_id, title,
//   messages: [{ id, speaker, text, at?, model? }] }. The same function reads every site; how to find each part of a
//   conversation on a site is that site's DATA row, so adding a site is a row, never a branch here. A row with
//   `earlier` also has its older messages read: the reader moves the chat's own scrolling pane back to the start,
//   waits for the page to add older messages, keeps every message it has seen (so a page that drops rows scrolled
//   out of view loses nothing), and puts the pane back where the person left it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It runs only when the person presses Save this chat, and only in the tab they are on (activeTab); it reads the
//      conversation that is open and nothing else on the page, and sends nothing itself.
//   2. readConversation is self-contained: chrome.scripting.executeScript sends its source into the page, so it may
//      not use anything from this module's scope. How many messages it has read so far is kept, while it reads, under
//      the name the caller hands in (progressKey), where the caller's next executeScript in the same tab reads it.
//   3. Words are kept as the page shows them: nothing is summarized. Parts the row names in skip (buttons, hidden
//      labels) are not words of the message; a picture keeps its alternative text.
//   4. A message with no id, speaker or words is left out, never guessed. A time is read only when the page shows
//      one; otherwise the account keeps the time it was saved.
//   5. Nothing here names a site: site names, selectors, speakers and how long to wait for older messages live in the
//      DATA row.
//   6. Messages do not nest: an element a message rule finds inside another element a rule found is part of that
//      message, never a message of its own.
//   7. Reading older messages stops when the page adds nothing more after the row's quiet_rounds waits of wait_ms at
//      the start of the chat, or at the row's max_messages or max_seconds, whichever comes first.
//
// KEY CONCEPTS
//   reader: { select?, all?, closest?, attribute?, value_from?, pattern?, map?, suffix?, value? } (see the DATA
//   file's about). A list of readers takes the first that finds something.
//   earlier: { pane?: [CSS selectors], wait_ms, quiet_rounds, step_ms, max_messages, max_seconds }. With no pane
//   found, the pane is the nearest scrolling element around the messages.

import { hostWithin } from 'trillion-workshop/tools/http-client/do-work/same-origin.mjs';

/** Where readConversation keeps how many messages it has read so far, for the popup to show while it reads. */
export const progressKey = 'trillionConversationRead';

/** The row for a page address, or null when no row reads it. */
export function siteFor(address, sites) {
  let url;
  try { url = new URL(address); } catch { return null; }
  const site = sites.find(row => row.hosts.some(name => hostWithin(url, name)));
  if (!site) return null;
  if (site.conversation_path && !new RegExp(site.conversation_path).test(url.pathname)) return null;
  return site;
}

/**
 * Runs inside the page. site: one row of conversation-sites.json; progressKey: where to keep { messages } read so
 * far. Resolves to { app, conversation_id, title, messages } or { app, problem: 'no-conversation' | 'no-messages' }.
 */
export async function readConversation(site, progressKey = null) {
  const pathMatch = site.conversation_path ? new RegExp(site.conversation_path).exec(location.pathname) : null;
  const skip = selector => (selector ? node => node.nodeType === 1 && node.matches(selector) : () => false);

  // The words of an element as a reader sees them: text (spaces collapsed where the page collapses them), a picture's
  // alternative text, and a line break between blocks, leaving out what skip names.
  const wordsOf = (element, skipped) => {
    let out = '';
    const breakLine = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const add = text => { out += /[ \n]$/.test(out) || !out ? text.replace(/^ /, '') : text; };
    const walk = node => {
      if (node.nodeType === 3) {
        const kept = /^pre/.test(getComputedStyle(node.parentElement).whiteSpace);
        add(kept ? node.data : node.data.replace(/[ \t\n\r\f]+/g, ' '));
        return;
      }
      if (node.nodeType !== 1 || skipped(node)) return;
      if (node.tagName === 'BR') { out += '\n'; return; }
      if (node.tagName === 'IMG') { add(node.getAttribute('alt') ?? ''); return; }
      const display = getComputedStyle(node).display;
      if (display === 'none') return;
      const block = !display.startsWith('inline') && display !== 'contents';
      if (block) breakLine();
      for (const child of node.childNodes) walk(child);
      if (block) breakLine();
    };
    walk(element);
    return out.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // The elements under root a selector finds that are not inside another one it finds under root, in page order.
  const outermost = (root, selector) => [...root.querySelectorAll(selector)].filter(node => {
    const around = node.parentElement?.closest(selector);
    return !around || (root !== document && !root.contains(around));
  });

  const read = (element, readers, skipped = () => false) => {
    for (const reader of readers ?? []) {
      let raw = null;
      if ('value' in reader) raw = reader.value;
      else if (reader.value_from === 'path') raw = pathMatch?.[1] ?? null;
      else if (reader.value_from === 'document_title') raw = document.title;
      else if (reader.value_from === 'text') raw = element ? wordsOf(element, skipped) : null;
      else {
        let at = element ?? document;
        if (reader.closest) at = at.closest ? at.closest(reader.closest) : null;
        const found = !at ? [] : !reader.select ? [at] : reader.all ? outermost(at, reader.select) : [at.querySelector(reader.select)];
        const values = found.filter(node => node && node !== document)
          .map(node => (reader.attribute ? node.getAttribute(reader.attribute) : wordsOf(node, skipped)))
          .filter(value => typeof value === 'string' && value.trim());
        if (values.length) raw = values.join('\n\n');
      }
      if (typeof raw !== 'string') continue;
      if (reader.pattern) raw = new RegExp(reader.pattern).exec(raw)?.[1] ?? null;
      if (raw !== null && reader.map) raw = Object.hasOwn(reader.map, raw) ? reader.map[raw] : null;
      if (typeof raw !== 'string') continue;
      raw = raw.trim();
      if (raw) return `${raw}${reader.suffix ?? ''}`;
    }
    return null;
  };

  // A time as a chat page writes it: an ISO time, or a clock and a date written in the page's own language order
  // ("10:32, 9/28/2026", "22:05, 28.09.26"). Anything else is no time.
  const timeOf = text => {
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) { const iso = new Date(text); return Number.isNaN(iso.getTime()) ? null : iso.toISOString(); }
    const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?/.exec(text);
    const numbers = text.replace(clock?.[0] ?? '', ' ').match(/\d+/g) ?? [];
    if (!clock || numbers.length !== 3) return null;
    const order = new Intl.DateTimeFormat(navigator.language, { year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(2006, 10, 22)).map(part => part.type).filter(type => ['year', 'month', 'day'].includes(type));
    const parts = Object.fromEntries(order.map((type, index) => [type, Number(numbers[index])]));
    if (parts.year < 100) parts.year += 2000;
    let hour = Number(clock[1]) % (clock[4] ? 12 : 24);
    if (clock[4] && /p/i.test(clock[4])) hour += 12;
    const when = new Date(parts.year, parts.month - 1, parts.day, hour, Number(clock[2]), Number(clock[3] ?? 0));
    return Number.isNaN(when.getTime()) || when.getMonth() !== parts.month - 1 ? null : when.toISOString();
  };

  if (progressKey) globalThis[progressKey] = { messages: 0 };
  const conversationId = read(null, site.conversation_id);
  if (!conversationId) return { app: site.app, problem: 'no-conversation' };

  const rules = site.messages;
  const selector = rules.map(rule => rule.select).join(', ');
  // Each message element is read once: a page keeps a message's element while the message stays on the page.
  const readOnce = new WeakMap();
  const messageOf = element => {
    if (readOnce.has(element)) return readOnce.get(element);
    const rule = rules.find(item => element.matches(item.select));
    const skipped = skip(rule.skip);
    const speaker = read(element, rule.speaker, skipped);
    const text = read(element, rule.text, skipped);
    const id = read(element, rule.id, skipped);
    const at = timeOf(read(element, rule.at, skipped));
    const model = read(element, rule.model, skipped);
    const message = speaker && text && id ? { id, speaker, text, ...(at ? { at } : {}), ...(model ? { model } : {}) } : null;
    readOnce.set(element, message);
    return message;
  };
  // The messages on the page now, in the order the page shows them, each with its element.
  const onPage = () => {
    const used = new Map();
    const found = [];
    for (const element of outermost(document, selector)) {
      const message = messageOf(element);
      if (!message) continue;
      // Two messages the page gives the same id (the same words said twice where the page gives none) stay apart.
      const seen = used.get(message.id) ?? 0;
      used.set(message.id, seen + 1);
      found.push({ element, message: seen ? { ...message, id: `${message.id}#${seen + 1}` } : message });
    }
    return found;
  };

  // Every message seen so far, in the page's order: each knows the one before and after it, so a message seen later
  // goes in beside the one it was seen next to.
  const kept = new Map();
  let first = null;
  const insertAfter = (id, previous) => {
    const next = kept.get(previous).after;
    Object.assign(kept.get(id), { before: previous, after: next });
    kept.get(previous).after = id;
    if (next) kept.get(next).before = id;
  };
  const insertBefore = (id, next) => {
    if (!next) { first = id; return; }
    const previous = kept.get(next).before;
    Object.assign(kept.get(id), { before: previous, after: next });
    kept.get(next).before = id;
    if (previous) kept.get(previous).after = id; else first = id;
  };
  const keep = found => {
    let previous = null;
    found.forEach(({ message }, index) => {
      if (!kept.has(message.id)) {
        kept.set(message.id, { message, before: null, after: null });
        // Seen before anything already kept on the page now: just before the first kept one after it, else at the start.
        if (previous) insertAfter(message.id, previous);
        else insertBefore(message.id, found.slice(index + 1).find(item => kept.has(item.message.id))?.message.id ?? first);
      }
      previous = message.id;
    });
    if (progressKey) globalThis[progressKey] = { messages: kept.size };
  };

  let found = onPage();
  keep(found);

  const earlier = site.earlier;
  const scrolls = node => Boolean(node) && /(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight;
  let pane = null;
  if (earlier && found.length) {
    pane = (earlier.pane ?? []).map(item => document.querySelector(item)).find(scrolls) ?? null;
    for (let node = found[0].element.parentElement; !pane && node; node = node.parentElement) if (scrolls(node)) pane = node;
    if (!pane && document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight) pane = document.scrollingElement;
  }
  if (pane) {
    const wait = ms => new Promise(done => setTimeout(done, ms));
    const moveTo = top => pane.scrollTo({ top, behavior: 'instant' });
    const paneTop = () => (pane === document.scrollingElement ? 0 : pane.getBoundingClientRect().top);
    // The message the person was looking at, and where, so the pane goes back there at the end.
    const anchor = found.find(item => item.element.getBoundingClientRect().bottom > paneTop())?.element ?? null;
    const anchorAt = anchor?.getBoundingClientRect().top ?? 0;
    const startedAt = Date.now();
    let quiet = 0;
    while (kept.size < (earlier.max_messages ?? Infinity) && Date.now() - startedAt < (earlier.max_seconds ?? 600) * 1000) {
      // Move so the earliest message on the page ends near the bottom of the pane: one move reaches the start of a
      // page that keeps every message, and a page that keeps only what is near the view is read a view at a time.
      const earliest = found[0]?.element;
      const rise = earliest?.isConnected
        ? paneTop() + pane.clientHeight - earliest.getBoundingClientRect().top - Math.min(earliest.offsetHeight, pane.clientHeight / 4)
        : pane.clientHeight;
      const before = pane.scrollTop;
      moveTo(before - Math.max(rise, pane.clientHeight / 2));
      if (pane.scrollTop !== before) {
        quiet = 0;
        await wait(earlier.step_ms ?? 100);
      } else {
        // At the start: a small move away and back tells the page it is being scrolled; then wait for older messages.
        const height = pane.scrollHeight;
        const size = kept.size;
        moveTo(before + pane.clientHeight / 4);
        await wait(50);
        moveTo(before);
        const until = Date.now() + (earlier.wait_ms ?? 1500);
        while (Date.now() < until && pane.scrollHeight === height && document.querySelector(selector) === found[0]?.element) await wait(100);
        found = onPage();
        keep(found);
        quiet = pane.scrollHeight === height && kept.size === size ? quiet + 1 : 0;
        if (quiet >= (earlier.quiet_rounds ?? 2)) break;
        continue;
      }
      found = onPage();
      keep(found);
    }
    if (anchor?.isConnected) moveTo(pane.scrollTop + anchor.getBoundingClientRect().top - anchorAt);
  }

  const messages = [];
  for (let id = first; id; id = kept.get(id).after) messages.push(kept.get(id).message);
  if (!messages.length) return { app: site.app, problem: 'no-messages' };
  return { app: site.app, conversation_id: conversationId, title: read(null, site.title), messages };
}
