// The email's drawing, moved whole from the product's old worker (parts/ui/show/document-page/document-page-html.mjs at 4ffa1dc4a2^: the
// markdown reader markdownBlocks/markdownText, the inline marks, and emailMessageHtml), plus the escape it imports
// (parts/ui/show/server-rendered-page/escape-html.mjs). emailMessageHtml draws a message { markdown, preheader, action, footer_lines,
// footer_links, site, palette, made_with } as email-safe html (tables and inline style only) and its plain text. The look it
// is drawn in is DATA (email-look.json); this file names no colour, face or site.

/** HTML-escape text going into an element or a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
import WORD_MARKS from './word-marks.json' with { type: 'json' };
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

// Letters for a face or a mark from a name: the first letter of its first two words.
function lettersOf(value) {
  return (textOrNull(value) ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0] ?? '').join('').toUpperCase();
}

/**
 * message: { preheader, markdown, action: {label, href}, footer_lines[], footer_links[{label, href}],
 *            site: {name, image}, palette: {ink, accent, muted, paper, line, on_accent, card?},
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
  const site = message?.site ?? {};
  const mark = safeHref(site.image) ? `<img src="${escapeHtml(site.image)}" alt="${escapeHtml(site.name ?? '')}" height="24" style="height:24px;width:auto;border:0"/>` : `<strong style="color:${ink}">${escapeHtml(site.name ?? '')}</strong>`;
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
