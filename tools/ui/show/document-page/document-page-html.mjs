// parts/ui/show/document-page/document-page-html.mjs
//
// A READABLE DOCUMENT, AN EMAIL AND A SHARE CARD, FROM DATA.
//
// Purpose: the HTML sink for pages a server sends ready to read (articles, guides, confirmation
// screens), for the bodies of emails, and for the card a browser photographs into a share image.
// Callers hand words, links and markdown; only this file writes tags, so a page, an email and a card
// are the same small set of parts wherever they are sent from.
//
// Non-negotiable invariants:
//   1. Every value from a caller is escaped before it reaches markup. Markdown is parsed here, and raw
//      HTML inside it is shown as text, never passed through.
//   2. A link is written only when its address is same-site (`/...`, `#...`) or `http(s)://`; anything
//      else is rendered as its words, so DATA can never become a script address.
//   3. There are no page kinds. A document is a head (title, description, canonical address, share
//      image, structured data), a header, a list of blocks and a footer. A block is the same shape
//      everywhere: optional date, heading, picture, a diagram (../layer-diagram) or typed graph document (../layer-diagram/graph-contract.mjs), markdown, links, a row of filters (links that
//      narrow the page, the current one marked), cards (a grid of picture cards, each one link), panels (titled cards side by side), questions (each opens
//      its own answer), a form, a note, and a tone (e.g. `callout`, `split` for the picture beside the words, or `timeline` for
//      dated entries on one rail, as a changelog). A new kind of page is new DATA.
//   4. Structured data (JSON-LD) is serialised by JSON.stringify with `<` escaped, so no string in it
//      can close the script element.
//   5. Colours are never written here. Pages read role tokens (`--ink`, `--thread`, `--grey-strong`,
//      `--surface-base`) from the site's theme stylesheet; emails, which cannot read a stylesheet,
//      receive a palette object from the caller, who reads it from the same theme file.
//
// Key concepts: `documentPageHtml(page)`, `emailMessageHtml(message)`, `shareCardHtml(card)`,
// `markdownHtml(markdown)`, `markdownText(markdown)` (the plain-text twin used for email text parts).
//
// Security: no caller string is ever placed unescaped; form fields are named by plain words only;
// the only inline script is JSON-LD, built from values, never from caller markup.

import { escapeHtml } from 'trillion-workshop/tools/write-a-post-for-each-place/read-data/escape-html.mjs';
import { SHARE_ROW_CSS, SHARE_ROW_SCRIPT, shareRowHtml } from '../share-row/share-row-html.mjs';
import { SITE_NAV_CSS, SITE_NAV_SCRIPT, siteNavEntries } from '../site-nav/site-nav-look.mjs';
import { LAYER_DIAGRAM_CSS, layerDiagramHtml } from '../layer-diagram/layer-diagram.mjs';
import { graphDocumentHtml } from '../layer-diagram/graph-contract.mjs';
import WORD_MARKS from './word-marks.json' with { type: 'json' };

export { escapeHtml };

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function plainWord(value) {
  const word = textOrNull(value);
  return word && /^[a-z][a-z0-9_-]*$/.test(word) ? word : null;
}

export function safeHref(value) {
  const href = textOrNull(value);
  if (!href) return null;
  if ((href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#')) return href;
  return /^https?:\/\/[^\s]+$/i.test(href) ? href : null;
}

// A link that leaves the page (`newTab`) opens in a new tab and hands the page it opens nothing of this one.
// `mark` names the word mark (word-marks.json) a bare address was drawn as.
function linkHtml(label, href, className, newTab = false, mark = null) {
  const safe = safeHref(href);
  const words = escapeHtml(label);
  const away = newTab && !safe?.startsWith('#') ? ' target="_blank" rel="noopener noreferrer"' : '';
  const marked = mark ? ` data-mark="${escapeHtml(mark)}"` : '';
  return safe ? `<a class="${className}"${marked} href="${escapeHtml(safe)}"${away}>${words}</a>` : words;
}

// --------------------------------------------------------------------------------------------
// Markdown: headings (##, ###), paragraphs, bullet and numbered lists (with `[ ]` / `[x]` tasks), block
// quotes over several lines (holding their own paragraphs and lists), tables (a `|` header row over a
// `---` row), fenced code blocks (``` lines, kept verbatim), rules (---), bold, italic, struck words,
// inline code, links, pictures (`![words](address)`) and a line ending in two spaces or `\` kept as a
// break. That covers prose, notes, chat exports and reports; anything else is shown as the text it is.
// --------------------------------------------------------------------------------------------

const INLINE = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|~~([^~]+)~~)/g;
// A line ending in two spaces or a backslash breaks there (markdown's hard break). The break is carried
// inside the paragraph's words as this character and drawn as one wherever words are drawn.
const HARD_BREAK = '\u2028';

// Marks inside plain words (word-marks.json): one alternation, each mark a named group, matched only where a word or
// an address could start, so `page#part` and `me@example.com` stay words.
const MARK_ROWS = WORD_MARKS.marks;
const MARKS = new RegExp(`(?<![\\p{L}\\p{N}_/@#.:-])(?:${MARK_ROWS.map((row, index) => `(?<m${index}>${row.pattern})`).join('|')})`, 'gu');

function markedHtml(words, linkClass, newTab, links) {
  let out = '';
  let last = 0;
  for (const match of words.matchAll(MARKS)) {
    const index = MARK_ROWS.findIndex((_row, at) => match.groups[`m${at}`] !== undefined);
    const row = MARK_ROWS[index];
    out += escapeHtml(words.slice(last, match.index));
    out += row.link
      ? (links ? linkHtml(match[0], match[0], `${linkClass} doc-mark`, newTab, row.id) : escapeHtml(match[0]))
      : `<span class="doc-mark" data-mark="${escapeHtml(row.id)}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(words.slice(last));
}

// Plain words between the markdown's own parts: escaped, a kept line break drawn as one (`breaks`), and with `marks`
// each tag, handle and bare address drawn as its mark.
function wordsHtml(words, linkClass, newTab, links, { breaks = false, marks = false } = {}) {
  const lines = words.split(breaks ? /\n|\u2028/ : HARD_BREAK);
  return lines.map(line => (marks ? markedHtml(line, linkClass, newTab, links) : escapeHtml(line))).join('<br>');
}

// A picture written in the words: drawn only from an address a link could have (same site or the web), else its words.
function pictureHtml(alt, src, links) {
  const safe = safeHref(src);
  if (!safe || safe.startsWith('#') || !links) return escapeHtml(alt);
  return `<img class="doc-img" src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"/>`;
}

function inlineHtml(text, linkClass, newTab = false, links = true, words = {}) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    out += wordsHtml(text.slice(last, match.index), linkClass, newTab, links, words);
    if (match[2] !== undefined) out += `<strong>${inlineHtml(match[2], linkClass, newTab, links, words)}</strong>`;
    else if (match[3] !== undefined) out += `<em>${inlineHtml(match[3], linkClass, newTab, links, words)}</em>`;
    else if (match[4] !== undefined) out += `<code>${escapeHtml(match[4])}</code>`;
    else if (match[6] !== undefined) out += pictureHtml(match[5], match[6], links);
    else if (match[7] !== undefined) out += links ? linkHtml(match[7], match[8], linkClass, newTab) : escapeHtml(match[7]);
    else out += `<del>${inlineHtml(match[9], linkClass, newTab, links, words)}</del>`;
    last = match.index + match[0].length;
  }
  return out + wordsHtml(text.slice(last), linkClass, newTab, links, words);
}

function inlineText(text) {
  return text.replace(INLINE, (whole, _all, bold, italic, code, alt, src, label, href, struck) => {
    if (code !== undefined) return code;
    const held = bold ?? italic ?? struck;
    if (held !== undefined) return inlineText(held);
    const safe = safeHref(src ?? href);
    const words = src !== undefined ? alt : label;
    return safe ? `${words} (${safe})` : words;
  }).replaceAll(HARD_BREAK, '\n');
}

// A table row's cells: split on each `|` not escaped with a backslash, the outer pipes dropped.
function tableCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** Markdown blocks as a plain structure both renderers walk. */
export function markdownBlocks(markdown, { breaks = false } = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.map((line, at) => (line.endsWith(HARD_BREAK) || at === paragraph.length - 1 ? line : `${line}${breaks ? '\n' : ' '}`)).join('').replace(new RegExp(`${HARD_BREAK}$`), '') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) { flush(); continue; }
    // A fenced block keeps its lines exactly as written, up to its closing fence (or the end).
    const fence = /^(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (index += 1; index < lines.length && !lines[index].trim().startsWith(fence[1]); index += 1) code.push(lines[index]);
      blocks.push({ kind: 'code', language: fence[2] || null, text: code.join('\n') });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', level: Math.max(2, heading[1].length), text: heading[2].trim() }); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const items = [];
      for (; index < lines.length; index += 1) {
        const current = lines[index].trim();
        const item = ordered ? /^\d+[.)]\s+(.*)$/.exec(current) : /^[-*]\s+(.*)$/.exec(current);
        if (!item) {
          if (current && items.length && !/^(#{1,4}\s|>\s?)/.test(current) && lines[index].startsWith(' ')) {
            items[items.length - 1] += ` ${current}`;
            continue;
          }
          index -= 1;
          break;
        }
        items.push(item[1]);
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    // A quote runs over every following line that starts with `>`; what it holds is markdown of its own.
    if (/^>/.test(line)) {
      flush();
      const inner = [];
      for (; index < lines.length && /^>/.test(lines[index].trim()); index += 1) inner.push(lines[index].trim().replace(/^>\s?/, ''));
      index -= 1;
      const held = markdownBlocks(inner.join('\n'), { breaks });
      blocks.push({ kind: 'quote', text: held.map(block => block.text ?? (block.items ?? []).join(' ')).filter(Boolean).join(' '), blocks: held });
      continue;
    }
    // A table: a row of cells over a row of dashes, then every row of cells that follows.
    if (line.includes('|') && index + 1 < lines.length && lines[index + 1].includes('|') && TABLE_RULE.test(lines[index + 1].trim())) {
      flush();
      const head = tableCells(line);
      const align = tableCells(lines[index + 1]).map(cell => (cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : null));
      const rows = [];
      for (index += 2; index < lines.length && lines[index].trim().includes('|'); index += 1) {
        const cells = tableCells(lines[index]);
        rows.push(head.map((_cell, column) => cells[column] ?? ''));
      }
      index -= 1;
      blocks.push({ kind: 'table', head, align: head.map((_cell, column) => align[column] ?? null), rows });
      continue;
    }
    paragraph.push(/(?: {2,}|\\)$/.test(lines[index]) ? `${line.replace(/\\$/, '')}${HARD_BREAK}` : line);
  }
  flush();
  return blocks;
}

// A list item, with a task's box drawn as done or not (`[x]` / `[ ]` at its start).
function listItemHtml(item, line) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
  if (!task) return `<li>${line(item)}</li>`;
  const done = task[1] !== ' ';
  return `<li class="doc-task" data-done="${done}"><span class="doc-task-box" role="img" aria-label="${done ? 'Done' : 'To do'}"></span>${line(task[2])}</li>`;
}

// A parsed block written back as markdown, so a quote's own parts are drawn by the same renderer.
function blockMarkdown(block) {
  if (block.kind === 'heading') return `${'#'.repeat(block.level)} ${block.text}`;
  if (block.kind === 'list') return block.items.map((item, at) => `${block.ordered ? `${at + 1}.` : '-'} ${item}`).join('\n');
  if (block.kind === 'code') return `\`\`\`${block.language ?? ''}\n${block.text}\n\`\`\``;
  if (block.kind === 'rule') return '---';
  if (block.kind === 'quote') return block.blocks.map(blockMarkdown).join('\n\n').split('\n').map((row) => `> ${row}`).join('\n');
  if (block.kind === 'table') return [block.head, block.head.map(() => '---'), ...block.rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return block.text.split(HARD_BREAK).join('\\\n');
}

/** Markdown as HTML. `newTab` opens every link that leaves the page in a new tab (a file shown inside another app).
 *  `breaks` draws each line break inside a paragraph as one (words written for a post or a message, not wrapped
 *  prose); `marks` draws tags, handles and bare addresses in plain words as marks (word-marks.json). */
export function markdownHtml(markdown, { linkClass = 'doc-link', newTab = false, links = true, breaks = false, marks = false } = {}) {
  const words = { breaks, marks };
  const line = text => inlineHtml(text, linkClass, newTab, links, words);
  const blocks = markdownBlocks(markdown, { breaks });
  const anchors = headingAnchors(blocks);
  return blocks.map((block, index) => {
    if (block.kind === 'heading') {
      const level = Math.min(4, block.level);
      return `<h${level} class="doc-h${level}" id="${escapeHtml(anchors[index])}">${line(block.text)}</h${level}>`;
    }
    if (block.kind === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} class="doc-list">${block.items.map((item) => listItemHtml(item, line)).join('')}</${tag}>`;
    }
    // A one-line quote stays the page's pull quote; a quote holding several parts draws each of them.
    if (block.kind === 'quote') return block.blocks?.length > 1 || (block.blocks?.length === 1 && block.blocks[0].kind !== 'paragraph')
      ? `<blockquote class="doc-quote doc-quote--held">${markdownHtml(block.blocks.map(blockMarkdown).join('\n\n'), { linkClass, newTab, links, breaks, marks })}</blockquote>`
      : `<blockquote class="doc-quote">${line(block.text)}</blockquote>`;
    if (block.kind === 'table') {
      const cell = (tag, words, column) => `<${tag}${block.align[column] ? ` data-align="${block.align[column]}"` : ''}>${line(words)}</${tag}>`;
      return '<div class="doc-table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table class="doc-table">'
        + `<thead><tr>${block.head.map((words, column) => cell('th', words, column)).join('')}</tr></thead>`
        + `<tbody>${block.rows.map((row) => `<tr>${row.map((words, column) => cell('td', words, column)).join('')}</tr>`).join('')}</tbody>`
        + '</table></div>';
    }
    if (block.kind === 'paragraph' && /^!\[[^\]]*\]\([^)\s]+\)$/.test(block.text)) return `<p class="doc-p doc-p--picture">${line(block.text)}</p>`;
    if (block.kind === 'code') return `<pre class="doc-code"><code>${escapeHtml(block.text)}</code></pre>`;
    if (block.kind === 'rule') return '<hr class="doc-rule">';
    return `<p class="doc-p">${line(block.text)}</p>`;
  }).join('');
}

export function markdownText(markdown) {
  return markdownBlocks(markdown).map((block) => {
    if (block.kind === 'heading') return inlineText(block.text).toUpperCase();
    if (block.kind === 'list') return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${inlineText(item)}`).join('\n');
    if (block.kind === 'quote') return `> ${inlineText(block.text)}`;
    if (block.kind === 'table') return [block.head, ...block.rows].map((row) => row.map(inlineText).join(' | ')).join('\n');
    if (block.kind === 'code') return block.text;
    if (block.kind === 'rule') return '---';
    return inlineText(block.text);
  }).join('\n\n');
}

/** The id a heading gets, so a table of contents or a share link can point at it. */
export function anchorFor(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/** One unique anchor per heading, in document order: a repeated heading gets -1, -2 … after its first (as GitHub
 *  numbers them), skipping any a heading already takes, so every link to a heading lands on the one it names. Answers
 *  one entry per block (null for a block that is not a heading). */
export function headingAnchors(blocks) {
  const taken = new Set();
  const counts = new Map();
  return blocks.map((block) => {
    if (block?.kind !== 'heading') return null;
    const base = anchorFor(block.text) || 'section';
    let count = counts.get(base) ?? 0;
    let anchor = count === 0 ? base : `${base}-${count}`;
    while (taken.has(anchor)) { count += 1; anchor = `${base}-${count}`; }
    counts.set(base, count + 1);
    taken.add(anchor);
    return anchor;
  });
}

// --------------------------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------------------------

function fieldHtml(field) {
  const name = plainWord(field?.name);
  const kind = plainWord(field?.kind) ?? 'text';
  if (!name) return '';
  if (kind === 'hidden') return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(field?.value ?? '')}"/>`;
  const label = textOrNull(field?.label) ?? name;
  const id = `doc-field-${name}`;
  // A field whose DATA says `trap` is invisible to people and left empty by them; the server treats a
  // filled one as automated. It is still labelled, so a screen reader announces it as not to be filled.
  const trap = field?.trap === true;
  return `<label class="doc-field${trap ? ' doc-field--trap' : ''}" for="${escapeHtml(id)}">`
    + `<span class="doc-field-label">${escapeHtml(label)}</span>`
    + `<input class="doc-field-input" id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="${escapeHtml(kind)}"`
    + `${field?.required ? ' required' : ''}${trap ? ' tabindex="-1" autocomplete="off"' : ` autocomplete="${escapeHtml(plainWord(field?.autocomplete) ?? 'on')}"`}`
    + `${textOrNull(field?.placeholder) ? ` placeholder="${escapeHtml(field.placeholder)}"` : ''}`
    + `${!trap && textOrNull(field?.value) ? ` value="${escapeHtml(field.value)}"` : ''}/></label>`;
}

function formHtml(form) {
  const action = safeHref(form?.action);
  if (!action) return '';
  const fields = list(form?.fields).map(fieldHtml).join('');
  const submit = textOrNull(form?.submit_label) ?? 'Send';
  const note = textOrNull(form?.note);
  return `<form class="doc-form" method="post" action="${escapeHtml(action)}">`
    + `<div class="doc-form-row">${fields}<button class="doc-button" type="submit">${escapeHtml(submit)}</button></div>`
    + (note ? `<p class="doc-form-note">${escapeHtml(note)}</p>` : '')
    + '</form>';
}

function linksHtml(links) {
  const items = list(links).map((link) => {
    const title = textOrNull(link?.title);
    if (!title) return '';
    const detail = textOrNull(link?.detail);
    return `<li class="doc-links-item">${linkHtml(title, link?.href, 'doc-links-title')}`
      + (detail ? `<span class="doc-links-detail">${escapeHtml(detail)}</span>` : '') + '</li>';
  }).join('');
  return items ? `<ul class="doc-links">${items}</ul>` : '';
}

// A row of filters: each is a link that narrows the page (a server-side filter, so every filtered view has its own address
// a search engine can read), the current one marked for the reader and a screen reader. Anatomy after the topic chips above
// editorial article grids (21st.dev "Blog Grid With Filters"; Linear and Vercel blog indexes): one scrolling row of pills.
function filtersHtml(filters) {
  const items = list(filters?.items).map((item) => {
    const label = textOrNull(item?.label);
    const href = safeHref(item?.href);
    if (!label || !href) return '';
    const count = Number.isInteger(item?.count) && item.count >= 0 ? `<span class="doc-filter-count">${item.count}</span>` : '';
    return `<a class="doc-filter" href="${escapeHtml(href)}"${item?.current === true ? ' aria-current="page"' : ''}>${escapeHtml(label)}${count}</a>`;
  }).join('');
  return items ? `<nav class="doc-filters" aria-label="${escapeHtml(textOrNull(filters?.label) ?? 'Filter')}">${items}</nav>` : '';
}

// Picture cards in a grid, each card one link: its picture (sized, so nothing jumps while it loads), a short line above the
// title (a date, a shelf), the title and a line of detail. A card without a picture is the same card without one; a card
// never names a picture it was not given.
function cardsHtml(cards) {
  const items = list(cards).map((card) => {
    const title = textOrNull(card?.title);
    const href = safeHref(card?.href);
    if (!title || !href) return '';
    const src = safeHref(card?.image?.src);
    const size = (value) => (Number.isInteger(value) && value > 0 ? value : null);
    const sized = size(card?.image?.width) && size(card?.image?.height) ? ` width="${card.image.width}" height="${card.image.height}"` : '';
    const picture = src ? `<img class="doc-card-img" src="${escapeHtml(src)}" alt="${escapeHtml(card?.image?.alt ?? '')}"${sized} loading="lazy" decoding="async"/>` : '';
    const meta = textOrNull(card?.meta);
    const detail = textOrNull(card?.detail);
    return `<li class="doc-card"><a class="doc-card-link" href="${escapeHtml(href)}">${picture}`
      + (meta ? `<span class="doc-card-meta">${escapeHtml(meta)}</span>` : '')
      + `<span class="doc-card-title">${escapeHtml(title)}</span>`
      + (detail ? `<span class="doc-card-detail">${escapeHtml(detail)}</span>` : '') + '</a></li>';
  }).join('');
  return items ? `<ul class="doc-cards">${items}</ul>` : '';
}

// Panels side by side, each a titled card holding markdown: two tools' strengths, who each one fits, two price lists.
// The panel marked `current` is the page's own side and is drawn a step stronger. Anatomy after the paired cards of
// comparison pages (edge.so "What Obsidian does well / Why choose Eden"; 21st.dev "Comparison Cards"): equal columns on a
// wide screen, stacked on a phone.
function panelsHtml(panels) {
  const items = list(panels).map((panel) => {
    const title = textOrNull(panel?.title);
    const markdown = textOrNull(panel?.markdown);
    if (!title && !markdown) return '';
    return `<div class="doc-panel${panel?.current === true ? ' doc-panel--current' : ''}">`
      + (title ? `<h3 class="doc-panel-title">${escapeHtml(title)}</h3>` : '')
      + (markdown ? markdownHtml(markdown) : '') + '</div>';
  }).join('');
  return items ? `<div class="doc-panels">${items}</div>` : '';
}

// Questions a reader opens one at a time: each question is the control that shows its answer (a native disclosure, so it
// works with no script, from the keyboard and to a screen reader, and a search engine reads every answer).
function questionsHtml(questions) {
  const items = list(questions).map((item) => {
    const question = textOrNull(item?.question);
    const answer = textOrNull(item?.answer);
    if (!question || !answer) return '';
    return `<details class="doc-question"><summary class="doc-question-summary">${escapeHtml(question)}</summary>`
      + `<div class="doc-question-answer">${markdownHtml(answer)}</div></details>`;
  }).join('');
  return items ? `<div class="doc-questions">${items}</div>` : '';
}

// A calendar date a reader sees in words, with the machine date beside it when it is one (a day, a
// month or a year), and the caller's qualifier under it (e.g. that the date was pieced together).
function dateHtml(date) {
  const label = textOrNull(date?.label);
  if (!label) return '';
  const iso = textOrNull(date?.iso);
  const machine = iso && /^\d{4}(-\d{2}(-\d{2}(T[0-9:.]+Z?)?)?)?$/.test(iso) ? ` datetime="${escapeHtml(iso)}"` : '';
  const qualifier = textOrNull(date?.qualifier);
  return `<p class="doc-date"><time${machine}>${escapeHtml(label)}</time>`
    + (qualifier ? `<span class="doc-date-qualifier">${escapeHtml(qualifier)}</span>` : '') + '</p>';
}

// A picture or a video with its own size (so the page does not jump while it loads) and an optional caption. A video
// (media_type video/...) plays in place with its controls, quiet until the reader starts it.
function figureHtml(image) {
  const src = safeHref(image?.src);
  if (!src) return '';
  const size = (value) => (Number.isInteger(value) && value > 0 ? value : null);
  const width = size(image?.width);
  const height = size(image?.height);
  const caption = textOrNull(image?.caption);
  const sized = width && height ? ` width="${width}" height="${height}"` : '';
  const media = /^video\//.test(String(image?.media_type ?? ''))
    ? `<video class="doc-figure-img" src="${escapeHtml(src)}"${sized} controls playsinline preload="metadata" aria-label="${escapeHtml(image?.alt ?? '')}"></video>`
    : `<img class="doc-figure-img" src="${escapeHtml(src)}" alt="${escapeHtml(image?.alt ?? '')}"${sized} loading="lazy" decoding="async"/>`;
  return `<figure class="doc-figure">${media}`
    + (caption ? `<figcaption class="doc-figure-caption">${escapeHtml(caption)}</figcaption>` : '') + '</figure>';
}

// A block's one main action, a link drawn as the page's button (a sign-up, a booking).
function actionHtml(action) {
  const href = safeHref(action?.href);
  const label = textOrNull(action?.label);
  if (!href || !label) return '';
  return `<p class="doc-action"><a class="doc-button" href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
}

function blockHtml(block) {
  const tone = plainWord(block?.tone);
  const heading = textOrNull(block?.heading);
  const anchor = anchorFor(textOrNull(block?.id) ?? heading ?? '');
  const date = dateHtml(block?.date);
  const figure = figureHtml(block?.image);
  const words = (heading ? `<h2 class="doc-h2"${anchor ? ` id="${escapeHtml(anchor)}"` : ''}>${escapeHtml(heading)}</h2>` : '')
    + (tone === 'split' ? '' : figure)
    + layerDiagramHtml(block?.diagram)
    + graphDocumentHtml(block?.graph)
    + (textOrNull(block?.markdown) ? markdownHtml(block.markdown) : '')
    + linksHtml(block?.links)
    + filtersHtml(block?.filters)
    + cardsHtml(block?.cards)
    + panelsHtml(block?.panels)
    + questionsHtml(block?.questions)
    + actionHtml(block?.action)
    + (block?.form ? formHtml(block.form) : '')
    + (textOrNull(block?.note) ? `<p class="doc-note">${escapeHtml(block.note)}</p>` : '')
    + shareRowHtml(block?.share);
  if (!date && !words && !figure) return '';
  // On a timeline the date keeps its own column (held in view while its entry scrolls past on a wide
  // screen), so the rest of the entry is one body beside it. A split block holds its picture beside its words.
  const inner = tone === 'timeline' && words ? `${date}<div class="doc-timeline-body">${words}</div>`
    : tone === 'split' ? `${figure}<div class="doc-split-body">${date}${words}</div>`
    : date + words;
  return `<section class="doc-block${tone ? ` doc-block--${tone}` : ''}">${inner}</section>`;
}

// The blocks in order; each run of timeline blocks shares one rail, whose thread fills as the reader
// scrolls down it (TIMELINE_SCRIPT) and is simply full where no script runs or motion is reduced.
function blocksHtml(blocks) {
  let out = '';
  let run = '';
  const close = () => {
    if (run) out += `<div class="doc-timeline" data-timeline><span class="doc-timeline-beam" aria-hidden="true"></span>${run}</div>`;
    run = '';
  };
  for (const block of list(blocks)) {
    if (plainWord(block?.tone) === 'timeline') { run += blockHtml(block); continue; }
    close();
    out += blockHtml(block);
  }
  close();
  return out;
}

function jsonLdHtml(values) {
  return list(values).filter((value) => value && typeof value === 'object')
    .map((value) => `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`)
    .join('');
}

function metaHtml(page) {
  const title = escapeHtml(page?.title ?? '');
  const description = escapeHtml(page?.description ?? '');
  const canonical = safeHref(page?.canonical_url);
  const image = safeHref(page?.share_image_url);
  const kind = plainWord(page?.share_kind) ?? 'website';
  return `<title>${title}</title>`
    + '<meta name="color-scheme" content="light"/>'
    + `<meta name="description" content="${description}"/>`
    + (page?.noindex ? '<meta name="robots" content="noindex"/>' : '<meta name="robots" content="index, follow, max-image-preview:large"/>')
    + (canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"/>` : '')
    + `<meta property="og:type" content="${escapeHtml(kind)}"/>`
    + `<meta property="og:title" content="${title}"/>`
    + `<meta property="og:description" content="${description}"/>`
    + (canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}"/>` : '')
    + (textOrNull(page?.site_name) ? `<meta property="og:site_name" content="${escapeHtml(page.site_name)}"/>` : '')
    + (image ? `<meta property="og:image" content="${escapeHtml(image)}"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>` : '')
    + `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"/>`
    + `<meta name="twitter:title" content="${title}"/><meta name="twitter:description" content="${description}"/>`
    + (image ? `<meta name="twitter:image" content="${escapeHtml(image)}"/>` : '')
    + (textOrNull(page?.published_at) ? `<meta property="article:published_time" content="${escapeHtml(page.published_at)}"/>` : '')
    + (textOrNull(page?.modified_at) ? `<meta property="article:modified_time" content="${escapeHtml(page.modified_at)}"/>` : '')
    + list(page?.alternates).map((alt) => (safeHref(alt?.href) && textOrNull(alt?.type)
      ? `<link rel="alternate" type="${escapeHtml(alt.type)}" title="${escapeHtml(alt.title ?? '')}" href="${escapeHtml(alt.href)}"/>` : '')).join('');
}

// An icon is drawn from its shape rows ([element, attributes], the Lucide icon-node form the caller
// resolved from the icon's name); only shape elements and plain attribute names are written.
const ICON_SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
function iconSvg(nodes, className, size = 18) {
  const shapes = list(nodes).filter((node) => Array.isArray(node) && ICON_SHAPES.has(node[0])).map(([shape, attributes]) => `<${shape}${Object.entries(attributes ?? {})
    .filter(([name]) => /^[a-z][a-z-]*$/.test(name) && name !== 'key')
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')}/>`).join('');
  return shapes ? `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>` : '';
}

const CHEVRON = [['path', { d: 'm6 9 6 6 6-6' }]];

function brandHtml(brand, className, markClass) {
  const wordmark = !safeHref(brand?.image) && brand?.text_style === 'wordmark' ? ' data-brand-text="wordmark"' : '';
  const mark = safeHref(brand?.image)
    ? `<img class="${markClass}" src="${escapeHtml(brand.image)}" alt="${escapeHtml(brand?.name ?? '')}" width="${Number(brand?.width) || 120}" height="${Number(brand?.height) || 28}"/>`
    : escapeHtml(brand?.name ?? '');
  return `<a class="${className}"${wordmark} href="${escapeHtml(safeHref(brand?.href) ?? '/')}">${mark}</a>`;
}

function navLinkHtml(label, href, className) {
  const safe = safeHref(href);
  return safe ? `<a class="${className}" href="${escapeHtml(safe)}" data-nav-item="${escapeHtml(safe)}">${escapeHtml(label)}</a>` : '';
}

function navMenuHtml(entry, icons) {
  const { menu } = entry;
  const features = menu.items.map((row) => (safeHref(row.href) ? `<li><a class="site-nav__feature" href="${escapeHtml(safeHref(row.href))}" data-nav-item="${escapeHtml(safeHref(row.href))}">`
    + `<span class="site-nav__feature-icon">${iconSvg(icons?.[row.icon], 'site-nav__feature-svg')}</span>`
    + `<span class="site-nav__feature-name">${escapeHtml(row.name)}</span><span class="site-nav__feature-line">${escapeHtml(row.line)}</span></a></li>` : '')).join('');
  const previews = menu.items.filter((row) => row.preview && safeHref(row.preview.src) && safeHref(row.href)).map((row) => `<a class="site-nav__preview" href="${escapeHtml(safeHref(row.href))}" tabindex="-1">`
    + `<img class="site-nav__preview-img" src="${escapeHtml(row.preview.src)}" alt="${escapeHtml(row.preview.alt)}" width="${row.preview.width}" height="${row.preview.height}" loading="lazy"/>`
    + `<span class="site-nav__preview-name">${escapeHtml(row.name)}</span><span class="site-nav__preview-line">${escapeHtml(row.line)}</span></a>`).join('');
  const footer = menu.footer && safeHref(menu.footer.href) ? `<a class="site-nav__menu-footer" href="${escapeHtml(safeHref(menu.footer.href))}" data-nav-item="${escapeHtml(safeHref(menu.footer.href))}">`
    + `<span class="site-nav__menu-footer-label">${escapeHtml(menu.footer.label)}</span>`
    + (menu.footer.line ? `<span class="site-nav__menu-footer-line">${escapeHtml(menu.footer.line)}</span>` : '') + '</a>' : '';
  return `<li class="site-nav__item site-nav__item--menu" data-nav-menu>`
    + `<button class="site-nav__link site-nav__trigger" type="button" aria-expanded="false" aria-controls="${entry.id}" data-nav-item="">${escapeHtml(entry.label)}${iconSvg(CHEVRON, 'site-nav__chevron', 12)}</button>`
    + `<div class="site-nav__menu" id="${entry.id}"><div class="site-nav__menu-card"><div class="site-nav__menu-main">`
    + (menu.heading ? `<p class="site-nav__menu-heading">${escapeHtml(menu.heading)}</p>` : '')
    + `<ul class="site-nav__features">${features}</ul></div><div class="site-nav__menu-side">${previews}${footer}</div></div></div></li>`;
}

/**
 * The page's header: the brand and the site's top navigation, drawn from the nav DATA read by
 * `siteNavEntries` (the same reading the React `SiteNav` draws from), so every page shows the same
 * items. header: { brand: {name, image, href, width, height, text_style?: 'wordmark'}, nav, icons: {name: nodes}, toggle_label }
 */
function headerHtml(header) {
  const entries = siteNavEntries(header?.nav);
  const items = entries.items.map((entry) => (entry.menu ? navMenuHtml(entry, header.icons)
    : `<li class="site-nav__item">${navLinkHtml(entry.label, entry.href, 'site-nav__link')}</li>`)).join('');
  const actions = entries.actions.map((action) => navLinkHtml(action.label, action.href, `site-nav__action${action.primary ? ' site-nav__action--primary' : ''}`)).join('');
  const panel = items || actions
    ? `<button class="site-nav__toggle" type="button" aria-expanded="false" aria-controls="site-nav-panel">${escapeHtml(textOrNull(header?.toggle_label) ?? 'Menu')}</button>`
      + `<nav class="site-nav__panel" id="site-nav-panel" aria-label="${escapeHtml(entries.label)}"><ul class="site-nav__list">${items}</ul>`
      + (actions ? `<div class="site-nav__actions">${actions}</div>` : '') + '</nav>'
    : '';
  return `<header class="site-nav" data-site-nav><div class="site-nav__bar">${brandHtml(header?.brand, 'site-nav__brand', 'site-nav__brand-mark')}${panel}</div></header>`;
}

// The footer: the site's links, then columns of links under their own headings (every comparison, grouped by what the
// tools do, the way edge.so's footer lists each "Eden vs" page), then its lines.
function footerHtml(footer) {
  const lines = list(footer?.lines).map((line) => `<p class="doc-footer-line">${escapeHtml(line)}</p>`).join('');
  const links = list(footer?.links).map((link) => linkHtml(link?.label ?? '', link?.href, 'doc-footer-link')).join('');
  const columns = list(footer?.columns).map((column) => {
    const items = list(column?.links).map((link) => (textOrNull(link?.label) ? `<li>${linkHtml(link.label, link?.href, 'doc-footer-link')}</li>` : '')).join('');
    const heading = textOrNull(column?.heading);
    return items ? `<div class="doc-footer-column">${heading ? `<p class="doc-footer-heading">${escapeHtml(heading)}</p>` : ''}<ul class="doc-footer-list">${items}</ul></div>` : '';
  }).join('');
  return `<footer class="doc-footer">${links ? `<nav class="doc-footer-nav">${links}</nav>` : ''}`
    + (columns ? `<nav class="doc-footer-columns" aria-label="${escapeHtml(textOrNull(footer?.columns_label) ?? 'More')}">${columns}</nav>` : '')
    + `${lines}</footer>`;
}

/**
 * The whole document.
 * page: { lang, theme_attributes: {name: value}, title, description, canonical_url, share_image_url,
 *         share_kind, site_name, published_at, noindex, alternates[], stylesheets[], icons[],
 *         json_ld[], header: {brand, nav, icons}, article: { title, lead, byline, markdown, toc: bool, contents_label, share }, blocks[], footer }
 *         (`article.toc` draws the article's minimap: every section of the article and of the page's blocks, see minimapHtml)
 *         (`article.share` and a block's `share`, { url, text, compact? }, draw the shared share row, ../share-row)
 */
export function documentPageHtml(page) {
  const attributes = Object.entries(page?.theme_attributes ?? {})
    .filter(([name]) => /^data-[a-z-]+$/.test(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  const stylesheets = list(page?.stylesheets).map((href) => (safeHref(href) ? `<link rel="stylesheet" href="${escapeHtml(href)}"/>` : '')).join('');
  const icons = list(page?.icons).map((icon) => (safeHref(icon?.href)
    ? `<link rel="${escapeHtml(plainWord(icon?.rel) ?? 'icon')}"${icon?.type ? ` type="${escapeHtml(icon.type)}"` : ''} href="${escapeHtml(icon.href)}"/>` : '')).join('');
  const body = documentBodyHtml(page);
  return `<!doctype html><html lang="${escapeHtml(page?.lang ?? 'en')}"${attributes}><head>`
    + '<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + documentHeadHtml(page) + icons + stylesheets
    + `<style>${DOCUMENT_CSS}${SITE_NAV_CSS}${diagramCss(body)}</style>`
    + `</head><body class="doc-page">${body}<script>${SITE_NAV_SCRIPT}</script>`
    + (/data-minimap/.test(body) ? `<script>${MINIMAP_SCRIPT}</script>` : '')
    + (/data-share-row/.test(body) ? `<script>${SHARE_ROW_SCRIPT}</script>` : '')
    + (/data-timeline/.test(body) ? `<script>${TIMELINE_SCRIPT}</script>` : '')
    + (list(page?.placements).length ? '<script type="module" src="/capabilities/runtime.js"></script>' : '')
    + '</body></html>';
}

// Public Sites resolves the declared placement ids and owns their controls and
// requests. Documents only provide hosts within their existing page frame.
function capabilityMountsHtml(placements = []) {
  if (!Array.isArray(placements) || placements.length > 40 || placements.some(id => !/^[a-z][a-z0-9-]{1,79}$/.test(id))) {
    throw new TypeError('Capability mounts need declared placement ids.');
  }
  return [...new Set(placements)].map(id => `<div class="trillion-capability-slot" id="${id}" data-trillion-placement="${id}"></div>`).join('');
}

/**
 * The head facts of a page (title, description, robots, canonical address, Open Graph and Twitter
 * card, alternates, structured data), for a page whose own shell another build wrote (a landing page
 * drawn in the browser): the server adds these to that shell's head so every page is described the
 * same way. `documentPageHtml` uses the same function.
 */
export function documentHeadHtml(page) {
  return metaHtml(page) + jsonLdHtml(page?.json_ld);
}

/**
 * The readable body of a page: header (the site nav), the article, its blocks and the footer. For a
 * page drawn in the browser it is the same words as plain markup, so a reader or crawler that runs no
 * script still reads the page; with `hidden_when_scripted` it is shown only where no script runs (the
 * browser's own drawing replaces it).
 */
export function documentBodyHtml(page) {
  const article = page?.article;
  // The contents links use the same anchors the body's headings get (headingAnchors over the same blocks).
  const articleBlocks = article?.toc ? markdownBlocks(article.markdown) : [];
  const articleAnchors = headingAnchors(articleBlocks);
  const sections = article?.toc ? [
    ...articleBlocks.map((b, index) => ({ anchor: articleAnchors[index], label: inlineText(b.text ?? '') })).filter((b, index) => articleBlocks[index].kind === 'heading' && articleBlocks[index].level === 2),
    ...list(page?.blocks).map(blockSection).filter(Boolean),
  ] : [];
  const articleHtml = article ? '<article class="doc-article">'
    + `<h1 class="doc-h1">${escapeHtml(article.title ?? '')}</h1>`
    + (textOrNull(article.lead) ? `<p class="doc-lead">${escapeHtml(article.lead)}</p>` : '')
    + (textOrNull(article.byline) ? `<p class="doc-byline">${escapeHtml(article.byline)}</p>` : '')
    + (list(article.dates).map(dateHtml).join('') ? `<div class="doc-dates">${list(article.dates).map(dateHtml).join('')}</div>` : '')
    + minimapHtml(sections, textOrNull(article.contents_label) ?? 'On this page')
    + `<div class="doc-body">${markdownHtml(article.markdown)}</div>`
    + shareRowHtml(article.share)
    + '</article>' : '';
  const body = `${headerHtml(page?.header)}<main class="doc-main">${articleHtml}${blocksHtml(page?.blocks)}${capabilityMountsHtml(page?.placements)}</main>${footerHtml(page?.footer)}`;
  return page?.hidden_when_scripted
    ? `<script>document.documentElement.setAttribute('data-scripted','')</script><style>[data-scripted] .doc-unscripted{display:none}${DOCUMENT_CSS}${SITE_NAV_CSS}${diagramCss(body)}</style><div class="doc-unscripted doc-page">${body}</div>`
    : body;
}

/** A page block's section in the minimap: its heading under the same anchor blockHtml gives it. */
function blockSection(block) {
  const heading = textOrNull(block?.heading);
  const anchor = heading ? anchorFor(textOrNull(block?.id) ?? heading) : '';
  return anchor ? { anchor, label: heading } : null;
}

/**
 * The article's minimap: every section of the page, in order, as a list of links. Read without a script it is the
 * contents list under the byline; on a screen wide enough to hold it beside the column it is a rail fixed at the
 * right, and MINIMAP_SCRIPT marks the section being read (aria-current), after the site's landing minimap. A page with
 * fewer than two sections has nothing to map.
 */
function minimapHtml(sections, label) {
  if (sections.length < 2) return '';
  return `<nav class="doc-minimap" data-minimap aria-label="${escapeHtml(label)}"><p class="doc-minimap-title">${escapeHtml(label)}</p><ol>`
    + sections.map((section) => `<li><a href="#${escapeHtml(section.anchor)}">${escapeHtml(section.label)}</a></li>`).join('')
    + '</ol></nav>';
}

// The diagram's look is sent only with a page that draws one.
const diagramCss = (body) => (body.includes('class="layer-diagram"') ? LAYER_DIAGRAM_CSS : '');

const DOCUMENT_CSS = `
.doc-page{margin:0;background:var(--ground-surface, var(--surface-base));color:var(--words-primary, var(--ink));font-family:var(--font-primary,var(--font-primary));-webkit-font-smoothing:antialiased}
.doc-page{--share-ink:var(--ink);--share-muted:var(--grey-strong);--share-line:var(--grey-soft);--share-fill:var(--paper-tint);--share-strong:var(--button-bg);--share-on-strong:var(--button-text);--share-focus:var(--focus-ring)}
.doc-footer-link{color:var(--words-secondary, var(--grey-strong));text-decoration:none;font-size:15px}
.doc-footer-link:hover{color:var(--words-primary, var(--ink))}
.doc-main{max-width:720px;margin:0 auto;padding:40px 24px 24px;overflow-wrap:break-word}
.doc-h1{margin:0 0 20px;font-family:var(--font-display);font-weight:400;font-size:clamp(36px,6vw,52px);line-height:1.1;letter-spacing:-.01em}
.doc-lead{margin:0 0 20px;font-size:21px;line-height:1.5;color:var(--words-secondary, var(--grey-strong))}
.doc-byline{margin:0 0 32px;font-size:14px;color:var(--grey)}
.doc-minimap{margin:0 0 36px;padding:18px 22px;border:1px solid var(--grey-soft);border-radius:14px}
.doc-minimap-title{margin:0 0 8px;font-size:13px;color:var(--words-secondary, var(--grey-strong))}
.doc-minimap ol{margin:0;padding:0;list-style:none}.doc-minimap li{margin:0}
.doc-minimap a{display:grid;grid-template-columns:8px minmax(0,1fr);gap:10px;align-items:center;padding:5px 0;color:var(--words-secondary, var(--grey-strong));text-decoration:none;line-height:1.3;transition:color .16s ease}
.doc-minimap a::before{content:'';width:6px;height:6px;border-radius:999px;background:var(--grey-soft);transition:background .16s ease,transform .16s ease}
.doc-minimap a:hover,.doc-minimap a[aria-current=location]{color:var(--words-primary, var(--ink))}
.doc-minimap a[aria-current=location]::before{background:var(--focus-ring, var(--ink));transform:scale(1.35)}
.doc-minimap a:focus-visible{border-radius:6px;outline:2px solid var(--focus-ring);outline-offset:3px}
@media (min-width:1240px){.doc-minimap{position:fixed;right:18px;top:50%;transform:translateY(-50%);z-index:5;width:200px;max-height:76vh;overflow-y:auto;margin:0;padding:12px 14px;background:var(--ground-surface, var(--surface-base));font-size:12px}.doc-minimap a{min-height:30px;padding:3px 0}}
@media (prefers-reduced-motion:reduce){.doc-minimap a,.doc-minimap a::before{transition:none}}
.doc-body,.doc-block{font-size:18px;line-height:1.7}
.doc-h2{margin:44px 0 12px;font-family:var(--font-display);font-weight:400;font-size:30px;line-height:1.2}
.doc-h3,.doc-h4{margin:32px 0 8px;font-size:20px;line-height:1.35;font-weight:600}
.doc-p{margin:0 0 18px}.doc-list{margin:0 0 20px;padding-left:24px;list-style:disc}ol.doc-list{list-style:decimal}.doc-list li{margin:6px 0}
.doc-quote{margin:28px 0;font-family:var(--font-display);font-size:1.3em;line-height:1.4;color:var(--words-primary, var(--ink))}
.doc-link,.doc-links-title{color:var(--words-primary, var(--ink));text-decoration:underline;text-decoration-color:var(--words-accent, var(--thread));text-underline-offset:3px}
.doc-block{margin:48px 0 0;padding-top:32px;border-top:1px solid var(--grey-soft)}
.doc-block--callout{padding:28px;border:1px solid var(--grey-soft);border-radius:18px;background:var(--ground-card, var(--paper-tint))}
.doc-block>:first-child{margin-top:0}
.doc-dates{display:flex;flex-wrap:wrap;gap:0 16px;margin:0 0 24px}.doc-dates .doc-date{margin:0}
.doc-date{margin:0 0 8px;font-size:13px;color:var(--words-secondary, var(--grey-strong))}
.doc-figure{margin:4px 0 22px}.doc-figure-img{display:block;width:100%;height:auto;border:1px solid var(--grey-soft);border-radius:14px}
.doc-figure-caption{margin:8px 0 0;font-size:14px;line-height:1.5;color:var(--words-secondary, var(--grey-strong))}
.doc-timeline{position:relative;--timeline-progress:1}
.doc-article+.doc-timeline{margin-top:40px}
.doc-timeline::before{content:'';position:absolute;left:12px;top:6px;bottom:8px;width:2px;border-radius:2px;background:linear-gradient(to bottom,transparent,var(--grey-soft) 4%,var(--grey-soft) 96%,transparent)}
.doc-timeline-beam{position:absolute;left:12px;top:6px;width:2px;height:calc((100% - 14px) * var(--timeline-progress));border-radius:2px;background:linear-gradient(to bottom,transparent,var(--ground-accent, var(--thread)) 60px)}
.doc-block--timeline{position:relative;margin:0;padding:0 0 56px 44px;border-top:0}
.doc-block--timeline::before{content:'';position:absolute;left:7px;top:5px;width:8px;height:8px;border-radius:50%;background:var(--ground-accent, var(--thread));box-shadow:0 0 0 4px var(--surface-base);transition:background-color .3s}
.doc-timeline[data-timeline-live] .doc-block--timeline:not([data-reached])::before{background:var(--grey-soft)}
.doc-block--timeline:last-child{padding-bottom:8px}
.doc-block--timeline .doc-h2{margin:0 0 14px}
.doc-date-qualifier{display:block;margin-top:4px;font-size:12px;letter-spacing:.04em;text-transform:none;color:var(--grey)}
@media (min-width:960px){
.doc-timeline{width:min(1040px,calc(100vw - 48px));margin-left:calc(50% - min(520px,50vw - 24px))}
.doc-block--timeline{display:grid;grid-template-columns:232px minmax(0,1fr);column-gap:48px;padding-bottom:88px}
.doc-block--timeline>.doc-date{position:sticky;top:96px;align-self:start;margin:0;font-family:var(--font-display);font-size:28px;line-height:1.15;letter-spacing:0;text-transform:none;color:var(--words-secondary, var(--grey-strong))}
.doc-block--timeline>.doc-date .doc-date-qualifier{font-family:var(--font-primary,var(--font-primary));font-size:13px;margin-top:8px}
.doc-block--timeline>.doc-timeline-body{grid-column:2}
.doc-block--timeline::before{top:14px}
}
.doc-links{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:14px}
.doc-links-item{display:grid;gap:2px}.doc-links-title{font-weight:600}
.doc-links-detail{font-size:15px;color:var(--words-secondary, var(--grey-strong));line-height:1.5}
.doc-filters{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:8px 0 28px;padding:2px 0}.doc-filters::-webkit-scrollbar{display:none}
.doc-filter{flex:none;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border:1px solid var(--grey-soft);border-radius:999px;font-size:15px;line-height:1.2;color:var(--words-primary, var(--ink));text-decoration:none;white-space:nowrap;transition:border-color .16s ease,background .16s ease}
.doc-filter:hover{border-color:var(--words-secondary, var(--grey-strong))}
.doc-filter[aria-current]{background:var(--button-bg);border-color:var(--button-bg);color:var(--button-text)}
.doc-filter-count{font-size:13px;opacity:.65}
.doc-cards{list-style:none;margin:0;padding:0;display:grid;gap:40px 28px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.doc-card{min-width:0}
.doc-card-link{display:grid;gap:8px;color:var(--words-primary, var(--ink));text-decoration:none}
.doc-card-img{display:block;width:100%;height:auto;aspect-ratio:1200/630;object-fit:cover;border:1px solid var(--grey-soft);border-radius:14px;margin-bottom:6px;transition:transform .24s ease}
.doc-card-link:hover .doc-card-img{transform:translateY(-2px)}
.doc-card-meta{font-size:14px;color:var(--words-secondary, var(--grey-strong))}
.doc-card-title{font-family:var(--font-display);font-size:24px;line-height:1.2}
.doc-card-link:hover .doc-card-title{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.doc-card-detail{font-size:15px;line-height:1.5;color:var(--words-secondary, var(--grey-strong))}
@media (min-width:960px){.doc-block:has(>.doc-cards){width:min(1160px,calc(100vw - 48px));margin-left:calc(50% - min(580px,50vw - 24px))}}
@media (prefers-reduced-motion:reduce){.doc-card-img,.doc-filter{transition:none}.doc-card-link:hover .doc-card-img{transform:none}}
.doc-form{margin:16px 0 0}.doc-form-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.doc-field{display:grid;gap:6px;flex:1 1 240px;min-width:0}.doc-field-label{font-size:14px;color:var(--words-secondary, var(--grey-strong))}
.doc-field-input{box-sizing:border-box;width:100%;min-width:0;height:52px;font:inherit;font-size:17px;padding:0 14px;border:1px solid var(--grey-soft);border-radius:12px;background:var(--ground-card, var(--paper-tint));color:var(--words-primary, var(--ink))}
.doc-field-input:focus{outline:2px solid var(--focus-ring);outline-offset:1px}
.doc-field--trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.doc-button{box-sizing:border-box;font:inherit;font-size:17px;font-weight:600;padding:12px 20px;border:1px solid transparent;border-radius:var(--radius-control);background:var(--button-bg);color:var(--button-text);cursor:pointer}
/* A form's button stands exactly as tall as the field beside it. */
.doc-form-row .doc-button{height:52px;padding-block:0}
.doc-action{margin:20px 0 0}.doc-action .doc-button{display:inline-block;text-decoration:none}
.doc-button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.doc-form-note,.doc-note{margin:12px 0 0;font-size:14px;color:var(--words-secondary, var(--grey-strong));line-height:1.5}
.doc-table-wrap{margin:8px 0 22px;overflow-x:auto;border:1px solid var(--grey-soft);border-radius:14px}
.doc-table-wrap:focus-visible{outline:2px solid var(--words-primary, var(--ink));outline-offset:2px}
.doc-table{width:100%;border-collapse:collapse;font-size:16px;line-height:1.45}
.doc-table th,.doc-table td{padding:12px 16px;text-align:left;vertical-align:top}
.doc-table th{font-weight:600;background:var(--ground-card, var(--paper-tint));border-bottom:1px solid var(--grey-soft)}
.doc-table tr+tr td{border-top:1px solid var(--grey-soft)}
.doc-table [data-align=center]{text-align:center}.doc-table [data-align=right]{text-align:right}
.doc-table td:first-child{min-width:180px}
.doc-panels{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));margin:8px 0 0}
.doc-panel{padding:24px;border:1px solid var(--grey-soft);border-radius:18px;background:var(--ground-card, var(--paper-tint));min-width:0}
.doc-panel--current{border-color:var(--words-primary, var(--ink))}
.doc-panel-title{margin:0 0 10px;font-family:var(--font-display);font-weight:400;font-size:22px;line-height:1.25}
.doc-panel .doc-list{padding-left:20px}.doc-panel .doc-p:last-child,.doc-panel .doc-list:last-child{margin-bottom:0}
.doc-panel .doc-table-wrap{margin:0}
.doc-questions{border:1px solid var(--grey-soft);border-radius:18px;overflow:hidden;margin:8px 0 0}
.doc-question+.doc-question{border-top:1px solid var(--grey-soft)}
.doc-question-summary{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 20px;cursor:pointer;list-style:none;font-size:17px}
.doc-question-summary::-webkit-details-marker{display:none}
.doc-question-summary::after{content:"+";font-size:22px;line-height:1;color:var(--words-secondary, var(--grey-strong));transition:transform .2s ease}
.doc-question[open] .doc-question-summary::after{transform:rotate(45deg)}
.doc-question-summary:focus-visible{outline:2px solid var(--words-primary, var(--ink));outline-offset:-2px}
.doc-question-answer{padding:0 20px 6px;color:var(--words-secondary, var(--grey-strong))}
@media (min-width:960px){.doc-block:has(>.doc-panels),.doc-block--split{width:min(1160px,calc(100vw - 48px));margin-left:calc(50% - min(580px,50vw - 24px))}
.doc-block--split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:56px;align-items:center}
.doc-block--split>.doc-figure{margin:0}.doc-block--split .doc-h2{margin-top:0}}
.doc-footer-columns{display:grid;gap:28px 24px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin:20px 0 24px}
.doc-footer-heading{margin:0 0 8px;color:var(--words-primary, var(--ink));font-size:14px}
.doc-footer-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}.doc-footer-list .doc-footer-link{font-size:14px}
@media (min-width:960px){.doc-footer:has(.doc-footer-columns){max-width:1160px}}
@media (prefers-reduced-motion:reduce){.doc-question-summary::after{transition:none}}
.doc-footer{max-width:672px;margin:0 auto;padding:40px 0 56px;border-top:1px solid var(--grey-soft);font-size:14px;color:var(--words-secondary, var(--grey-strong))}
@media (max-width:720px){.doc-footer{margin:0 24px}}
.doc-footer-nav{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px}.doc-footer-line{margin:4px 0}
@media (max-width:560px){.doc-main{padding-top:28px}.doc-body,.doc-block{font-size:17px}.doc-lead{font-size:19px}}
${SHARE_ROW_CSS}`;

// The rail's thread follows the reader: it fills to the middle of the screen and each entry's dot lights
// as the thread reaches it. Written with values only; with reduced motion it leaves the rail full.
// The minimap marks the section being read: the last section whose heading has passed a line a quarter of the way
// down the window (the landing minimap's reading band), recomputed once per frame on scroll and resize.
const MINIMAP_SCRIPT = `(()=>{for(const map of document.querySelectorAll('[data-minimap]')){const links=[...map.querySelectorAll('a[href^="#"]')].map((a)=>[a,document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)))]).filter(([,h])=>h);if(!links.length)continue;let frame=0;const paint=()=>{frame=0;const line=innerHeight*0.25;let at=links[0];for(const pair of links){if(pair[1].getBoundingClientRect().top<=line)at=pair;}for(const [a] of links){if(a===at[0])a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');}};const ask=()=>{if(!frame)frame=requestAnimationFrame(paint);};addEventListener('scroll',ask,{passive:true});addEventListener('resize',ask);paint();}})();`;

const TIMELINE_SCRIPT = `(()=>{const rails=[...document.querySelectorAll('[data-timeline]')];if(!rails.length||matchMedia('(prefers-reduced-motion: reduce)').matches)return;let frame=0;const paint=()=>{frame=0;const mark=innerHeight*0.5;for(const rail of rails){const box=rail.getBoundingClientRect();rail.style.setProperty('--timeline-progress',Math.min(1,Math.max(0,(mark-box.top)/box.height)).toFixed(4));for(const entry of rail.children){if(entry.classList.contains('doc-block--timeline'))entry.toggleAttribute('data-reached',entry.getBoundingClientRect().top<mark);}}};const ask=()=>{if(!frame)frame=requestAnimationFrame(paint);};for(const rail of rails)rail.setAttribute('data-timeline-live','');addEventListener('scroll',ask,{passive:true});addEventListener('resize',ask);paint();})();`;

// --------------------------------------------------------------------------------------------
// Email
// --------------------------------------------------------------------------------------------

// Letters for a face or a mark from a name: the first letter of its first two words.
function lettersOf(value) {
  return (textOrNull(value) ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0] ?? '').join('').toUpperCase();
}

/**
 * message: { preheader, markdown, action: {label, href}, footer_lines[], footer_links[{label, href}],
 *            brand: {name, image}, palette: {ink, accent, muted, paper, line, on_accent, card?},
 *            mark?: {name, src?, alt?}, people?: {faces: [{name, src?}], more?, line} }
 * `mark` opens the message with what it is about (a picture, else the name's first letters on a tile); `people`
 * shows who is in it as a row of faces and one line, after the words and before the action.
 * Returns { html, text }.
 */
export function emailMessageHtml(message) {
  const p = message?.palette ?? {};
  const color = (value) => (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : 'inherit');
  const ink = color(p.ink); const accent = color(p.accent); const muted = color(p.muted);
  const paper = color(p.paper); const line = color(p.line); const onAccent = color(p.on_accent);
  // The action wears the look's primary button fill (src/mail-settings.json palette_roles `button`), not its accent.
  const buttonFill = color(p.button ?? p.accent);
  // The look's faces, as the email's palette carries them (src/mail-settings.json font_roles); single quotes only, so a
  // face name never closes the style attribute it sits in.
  const face = (value, generic) => (typeof value === 'string' && /^[\w\s,'"-]+$/.test(value) ? value.replace(/"/g, "'") : generic);
  // The look's corners, as the email's palette carries them (src/mail-settings.json radius_roles): a CSS length such as
  // '10px' (or a bare number). Read as pixels, bounded; a palette without one draws square corners.
  const radius = (value) => { const pixels = Number.parseFloat(value); return Number.isFinite(pixels) ? `${Math.max(0, Math.min(999, pixels))}px` : '0'; };
  const corner = { control: radius(p.radius_control), card: radius(p.radius_card), pill: radius(p.radius_pill) };
  const textFace = face(p.font, 'sans-serif'); const display = face(p.display_font, 'serif'); const mono = face(p.mono_font, 'monospace');
  const style = {
    p: `margin:0 0 16px;font-size:16px;line-height:1.6;color:${ink}`,
    h: `margin:28px 0 10px;font-family:${display};font-size:20px;line-height:1.3;color:${ink};font-weight:600`,
    list: `margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.6;color:${ink}`,
    quote: `margin:20px 0;font-family:${display};font-size:20px;line-height:1.45;color:${ink}`,
    code: `margin:0 0 16px;padding:12px 14px;border-radius:${corner.control};background:${line};font-family:${mono};font-size:14px;line-height:1.5;color:${ink};white-space:pre-wrap`,
    rule: `margin:24px 0;border:0;border-top:1px solid ${line}`,
  };
  const body = markdownBlocks(message?.markdown).map((block) => {
    const inline = (text) => inlineHtml(text, 'email-link').replace(/class="email-link"/g, `style="color:${ink};text-decoration:underline;text-decoration-color:${accent}"`);
    if (block.kind === 'heading') return `<h2 style="${style.h}">${inline(block.text)}</h2>`;
    if (block.kind === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} style="${style.list}">${block.items.map((item) => `<li style="margin:4px 0">${inline(item)}</li>`).join('')}</${tag}>`;
    }
    if (block.kind === 'quote') return `<blockquote style="${style.quote}">${inline(block.text)}</blockquote>`;
    if (block.kind === 'code') return `<pre style="${style.code}">${escapeHtml(block.text)}</pre>`;
    if (block.kind === 'rule') return `<hr style="${style.rule}"/>`;
    return `<p style="${style.p}">${inline(block.text)}</p>`;
  }).join('');
  const card = color(p.card ?? p.paper);
  const markSrc = safeHref(message?.mark?.src);
  const markLetters = lettersOf(message?.mark?.name);
  const markHtml = markSrc
    ? `<p style="margin:0 0 20px"><img src="${escapeHtml(markSrc)}" alt="${escapeHtml(message.mark.alt ?? '')}" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:${corner.card};border:0;object-fit:cover"/></p>`
    : markLetters ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td width="56" height="56" align="center" valign="middle" style="width:56px;height:56px;border-radius:${corner.card};background:${ink};color:${card};font-family:${display};font-size:22px;line-height:56px">${escapeHtml(markLetters)}</td></tr></table>` : '';
  const faceStyle = `width:32px;height:32px;border-radius:${corner.pill};font-size:12px;font-weight:600;line-height:32px;text-align:center`;
  const faces = list(message?.people?.faces).slice(0, 6).map((face, index) => {
    const src = safeHref(face?.src);
    const inner = src ? `<img src="${escapeHtml(src)}" alt="" width="32" height="32" style="display:block;width:32px;height:32px;border-radius:${corner.pill};border:0"/>` : escapeHtml(lettersOf(face?.name));
    return inner ? `<td style="padding:0 6px 0 0"><div style="${faceStyle};background:${index === 0 ? ink : line};color:${index === 0 ? card : ink}">${inner}</div></td>` : '';
  }).join('');
  const more = Number.isInteger(message?.people?.more) && message.people.more > 0
    ? `<td style="padding:0 6px 0 0"><div style="${faceStyle};background:${card};color:${muted}">+${message.people.more}</div></td>` : '';
  const peopleLine = textOrNull(message?.people?.line);
  const peopleHtml = faces || peopleLine
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr>${faces}${more}${peopleLine ? `<td style="padding:0 0 0 6px;font-size:14px;line-height:1.4;color:${muted}">${escapeHtml(peopleLine)}</td>` : ''}</tr></table>` : '';
  const buttonSheen = typeof p.button_sheen === 'string' && /^linear-gradient\([\w\s.,()%#-]+\)$/.test(p.button_sheen) ? p.button_sheen : 'none';
  const buttonShadow = [p.button_highlight, p.button_shadow].filter(value => typeof value === 'string' && /^[\w\s.,()%#-]+$/.test(value)).join(',');
  const action = message?.action && safeHref(message.action.href) && textOrNull(message.action.label)
    ? `<p style="margin:24px 0"><a href="${escapeHtml(message.action.href)}" style="display:inline-block;padding:12px 20px;border-radius:${corner.control};background:${buttonFill};background-image:${buttonSheen};color:${onAccent};box-shadow:${buttonShadow || 'none'};font-weight:600;text-decoration:none">${escapeHtml(message.action.label)}</a></p>`
    : '';
  const footerLinks = list(message?.footer_links).map((link) => (safeHref(link?.href)
    ? `<a href="${escapeHtml(link.href)}" style="color:${muted};text-decoration:underline">${escapeHtml(link.label ?? '')}</a>` : '')).filter(Boolean).join(' &middot; ');
  const footerLines = list(message?.footer_lines).map((l) => `<p style="margin:4px 0;font-size:12px;line-height:1.5;color:${muted}">${escapeHtml(l)}</p>`).join('');
  const madeWith = message?.made_with && safeHref(message.made_with.href)
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${muted}"><a href="${escapeHtml(message.made_with.href)}" style="color:${muted};text-decoration:none">${escapeHtml(message.made_with.label ?? '')}${safeHref(message.made_with.image) ? ` <img src="${escapeHtml(message.made_with.image)}" alt="${escapeHtml(message.made_with.alt ?? '')}" height="16" style="height:16px;width:auto;vertical-align:middle;border:0"/>` : ''}</a></p>` : '';
  const brand = message?.brand ?? {};
  const mark = safeHref(brand.image) ? `<img src="${escapeHtml(brand.image)}" alt="${escapeHtml(brand.name ?? '')}" height="24" style="height:24px;width:auto;border:0"/>` : `<strong style="color:${ink}">${escapeHtml(brand.name ?? '')}</strong>`;
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + `<meta name="color-scheme" content="${p.scheme === 'dark' ? 'dark' : 'light'}"/></head>`
    + `<body style="margin:0;padding:0;background:${paper}">`
    + (textOrNull(message?.preheader) ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.preheader)}</div>` : '')
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${paper}"><tr><td align="center" style="padding:32px 16px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;text-align:left;font-family:${textFace}">`
    + `<tr><td style="padding:0 0 24px">${mark}</td></tr>`
    + `<tr><td>${markHtml}${body}${peopleHtml}${action}</td></tr>`
    + `<tr><td style="padding:28px 0 0;border-top:1px solid ${line}">${footerLinks ? `<p style="margin:0 0 8px;font-size:12px;color:${muted}">${footerLinks}</p>` : ''}${footerLines}${madeWith}</td></tr>`
    + '</table></td></tr></table></body></html>';
  const text = [
    markdownText(message?.markdown),
    peopleLine ?? '',
    message?.action && safeHref(message.action.href) ? `${message.action.label}: ${message.action.href}` : '',
    '--',
    ...list(message?.footer_links).filter((l) => safeHref(l?.href)).map((l) => `${l.label}: ${l.href}`),
    ...list(message?.footer_lines),
    ...(message?.made_with?.label && message?.made_with?.alt ? [`${message.made_with.label} ${message.made_with.alt}: ${message.made_with.href}`] : []),
  ].filter(Boolean).join('\n\n');
  return { html, text };
}

// --------------------------------------------------------------------------------------------
// Share card (1200 x 630), photographed by a headless browser into the share image.
// --------------------------------------------------------------------------------------------

/**
 * card: { title, detail, brand: {name, image}, stylesheets[], theme_attributes, palette?, mark?, people? }
 * `palette` gives the card's roles (--surface-base, --ink, --thread, --grey-strong, --grey-soft) concrete values for
 * a caller whose stylesheet names them differently; `mark` ({name, src?}) sits beside the title as a picture or the
 * name's letters; `people` ({faces: [{name, src?}], more?, line}) is a row of faces and one line beside the brand.
 */
export function shareCardHtml(card) {
  const attributes = Object.entries(card?.theme_attributes ?? {})
    .filter(([name]) => /^data-[a-z-]+$/.test(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  const stylesheets = list(card?.stylesheets).map((href) => (safeHref(href) ? `<link rel="stylesheet" href="${escapeHtml(href)}"/>` : '')).join('');
  const brand = card?.brand ?? {};
  const mark = safeHref(brand.image) ? `<img src="${escapeHtml(brand.image)}" alt="" style="height:44px;width:auto"/>` : escapeHtml(brand.name ?? '');
  const palette = Object.entries(card?.palette && typeof card.palette === 'object' ? card.palette : {})
    .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && typeof value === 'string' && value.length <= 200 && !/[<>{};\\]/.test(value))
    .map(([name, value]) => `${name}:${value}`).join(';');
  const tileSrc = safeHref(card?.mark?.src);
  const tileLetters = lettersOf(card?.mark?.name);
  const tile = tileSrc ? `<img class="card-mark" src="${escapeHtml(tileSrc)}" alt=""/>` : tileLetters ? `<span class="card-mark">${escapeHtml(tileLetters)}</span>` : '';
  const faces = list(card?.people?.faces).slice(0, 6).map((face) => (safeHref(face?.src)
    ? `<img class="card-face" src="${escapeHtml(face.src)}" alt=""/>` : lettersOf(face?.name) ? `<span class="card-face">${escapeHtml(lettersOf(face.name))}</span>` : '')).join('')
    + (Number.isInteger(card?.people?.more) && card.people.more > 0 ? `<span class="card-face card-face--more">+${card.people.more}</span>` : '');
  const peopleLine = textOrNull(card?.people?.line);
  const people = faces || peopleLine ? `<div class="card-people">${faces ? `<span class="card-faces">${faces}</span>` : ''}${peopleLine ? `<span class="card-people-line">${escapeHtml(peopleLine)}</span>` : ''}</div>` : '<div></div>';
  return `<!doctype html><html lang="en"${attributes}><head><meta charset="utf-8"/>${stylesheets}<style>`
    + (palette ? `:root{${palette}}` : '')
    + 'html,body{margin:0;width:1200px;height:630px;overflow:hidden}'
    + ".card-top{display:flex;align-items:center;gap:36px}.card-mark{flex:none;box-sizing:border-box;width:132px;height:132px;border-radius:32px;object-fit:cover;background:var(--ground-ink, var(--ink));color:var(--words-on-ink, var(--surface-base));display:grid;place-items:center;font:400 56px var(--font-display)}"
    + '.card-foot{display:flex;align-items:center;justify-content:space-between;gap:24px}.card-people{display:flex;align-items:center;gap:18px}.card-faces{display:flex;padding-left:12px}'
    + ".card-face{box-sizing:border-box;display:grid;place-items:center;width:60px;height:60px;margin-left:-12px;border-radius:50%;border:4px solid var(--surface-base);background:var(--ground-surface, var(--surface-base));box-shadow:inset 0 0 0 2px var(--grey-soft, var(--border-primary));color:var(--words-primary, var(--ink));font:600 20px var(--font-primary);object-fit:cover}"
    + '.card-face:first-child{background:var(--ground-ink, var(--ink));color:var(--words-on-ink, var(--surface-base))}.card-face--more{background:var(--ground-surface, var(--surface-base));color:var(--words-secondary, var(--grey-strong))}'
    + ".card-people-line{font:400 26px var(--font-primary);color:var(--words-secondary, var(--grey-strong))}"
    + '.card{box-sizing:border-box;width:1200px;height:630px;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;background:var(--ground-surface, var(--surface-base));color:var(--words-primary, var(--ink));border-bottom:10px solid var(--mark-accent, var(--thread))}'
    + ".card-title{font-family:var(--font-display);font-weight:400;font-size:74px;line-height:1.05;margin:0;max-width:1000px}"
    + ".card-detail{font:400 28px var(--font-primary);color:var(--words-secondary, var(--grey-strong));margin:18px 0 0;max-width:980px}"
    + '</style></head><body><div class="card"><div>'
    + `<div class="card-top">${tile}<h1 class="card-title">${escapeHtml(card?.title ?? '')}</h1></div>`
    + (textOrNull(card?.detail) ? `<p class="card-detail">${escapeHtml(card.detail)}</p>` : '')
    + `</div><div class="card-foot">${people}<div>${mark}</div></div></div></body></html>`;
}

/**
 * One slide of a social carousel (Instagram's 4:5 portrait by default), in the same look as the share card:
 * `{ title, detail?, points?: string[], footer?, page?: {index, count}, brand, stylesheets,
 *   theme_attributes, width?, height? }`. Screenshot it at its size to get the image.
 */
export function carouselSlideHtml(slide) {
  const width = Number(slide?.width) || 1080;
  const height = Number(slide?.height) || 1350;
  const attributes = Object.entries(slide?.theme_attributes ?? {})
    .filter(([name]) => /^data-[a-z-]+$/.test(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  const stylesheets = list(slide?.stylesheets).map((href) => (safeHref(href) ? `<link rel="stylesheet" href="${escapeHtml(href)}"/>` : '')).join('');
  const brand = slide?.brand ?? {};
  const mark = safeHref(brand.image) ? `<img src="${escapeHtml(brand.image)}" alt="" style="height:48px;width:auto"/>` : escapeHtml(brand.name ?? '');
  const points = list(slide?.points).filter(textOrNull);
  const page = slide?.page && Number(slide.page.count) > 1 ? `${Number(slide.page.index)} / ${Number(slide.page.count)}` : '';
  return `<!doctype html><html lang="en"${attributes}><head><meta charset="utf-8"/>${stylesheets}<style>`
    + `html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}`
    + `.slide{box-sizing:border-box;width:${width}px;height:${height}px;padding:96px 88px 72px;display:flex;flex-direction:column;justify-content:space-between;background:var(--ground-surface, var(--surface-base));color:var(--words-primary, var(--ink));border-bottom:14px solid var(--mark-accent, var(--thread))}`
    + ".slide-title{font-family:var(--font-display);font-weight:400;font-size:112px;line-height:1.04;margin:0}"
    + ".slide-detail{font:400 46px/1.38 var(--font-primary);color:var(--words-secondary, var(--grey-strong));margin:36px 0 0}"
    + ".slide-points{margin:44px 0 0;padding:0 0 0 1.1em;font:400 46px/1.4 var(--font-primary)}"
    + '.slide-points{list-style:disc outside}.slide-points li{display:list-item;margin:0 0 20px}.slide-points li::marker{color:var(--words-accent, var(--thread))}.slide-body{flex:1;display:flex;flex-direction:column;justify-content:center}'
    + ".slide-foot{display:flex;align-items:center;justify-content:space-between;font:500 32px var(--font-primary);color:var(--words-secondary, var(--grey-strong))}"
    + '</style></head><body><div class="slide"><div class="slide-body">'
    + `<h1 class="slide-title">${escapeHtml(slide?.title ?? '')}</h1>`
    + (textOrNull(slide?.detail) ? `<p class="slide-detail">${escapeHtml(slide.detail)}</p>` : '')
    + (points.length ? `<ul class="slide-points">${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : '')
    + `</div><div class="slide-foot"><span>${mark}</span><span>${escapeHtml(textOrNull(slide?.footer) ?? page)}</span></div></div></body></html>`;
}
