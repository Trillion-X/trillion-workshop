// tools/send-messages/read-data/draw-an-email.mjs
//
// Purpose
//   Draws one email in a look: its words (markdown, or plain text read as markdown), an action button, footer lines and
//   links, the account's mark and its made-with line, as html every email client shows the same, with the same words
//   as plain text. do-work/mail-sender.mjs draws every email it sends through here.
//
// Non-negotiable invariants
//   1. Every email carries its plain text and its html, drawn from the same words.
//   2. A see-through look colour is laid over the paper colour, so every email client shows it solid.
//   3. The look's roles (which variable is the ink, the paper, the button) are DATA (read-data/email-look.json); an email
//      sent before the account has published a look is drawn in its `shipped_palette`; a look that cannot be read is not
//      drawn in other colours: the email is not sent, in BRAND_UNREAD's words.
//
// Moved from the older owner: its markdown reader and email part (parts/ui/show/document-page/document-page-html.mjs)
// and its mail sender's palette (src/mail-sender.mjs hex, rgba, toHex, solidColour, emailPalette, currentPalette,
// drawEmail).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../../write-a-post-for-each-place/read-data/escape-html.mjs';

export const EMAIL_LOOK = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'email-look.json'), 'utf8'));

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
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

// Plain words between the markdown's own parts: escaped, a kept line break drawn as one (`breaks`). An email draws
// no marks (tags, handles and bare addresses stay words).
function wordsHtml(words, linkClass, newTab, links, { breaks = false } = {}) {
  const lines = words.split(breaks ? /\n|\u2028/ : HARD_BREAK);
  return lines.map(line => escapeHtml(line)).join('<br>');
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

// --------------------------------------------------------------------------------------------
// The email's palette
// --------------------------------------------------------------------------------------------

const hex = value => {
  const long = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value ?? '');
  if (!long) return null;
  const digits = long[1].length === 3 ? [...long[1]].map(d => d + d).join('') : long[1];
  return [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16));
};
const rgba = value => {
  const parts = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value ?? '');
  return parts ? { rgb: parts.slice(1, 4).map(Number), alpha: parts[4] === undefined ? 1 : Number(parts[4]) } : null;
};
const toHex = rgb => `#${rgb.map(channel => Math.round(Math.min(Math.max(channel, 0), 255)).toString(16).padStart(2, '0')).join('')}`;

/** A colour as every email client shows it: a see-through one laid over `under` (itself solid). */
export function solidColour(value, under = '#ffffff') {
  if (hex(value)) return toHex(hex(value));
  const see = rgba(value);
  const base = hex(under) ?? [255, 255, 255];
  return see ? toHex(see.rgb.map((channel, index) => channel * see.alpha + base[index] * (1 - see.alpha))) : null;
}

// The relative lightness of a #rrggbb ground (WCAG), 1 for anything else; a ground darker than .18 is a dark look.
const lightness = value => {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) return 1;
  const rgb = [0, 2, 4].map(at => parseInt(match[1].slice(at, at + 2), 16) / 255);
  const linear = rgb.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
};
const lookScheme = palette => lightness(palette?.['--bg-primary'] ?? palette?.['--surface-base']) < .18 ? 'dark' : 'light';

/** The email's palette (its colours and faces), from the look's palette by the roles in DATA. */
export function emailPalette(lookPalette = EMAIL_LOOK.shipped_palette, settings = EMAIL_LOOK) {
  const paper = solidColour(lookPalette[settings.palette_roles.paper]);
  const colours = Object.entries(settings.palette_roles).map(([role, variable]) => [role, solidColour(lookPalette[variable], paper)]);
  const faces = Object.entries(settings.font_roles).map(([role, variable]) => [role, lookPalette[variable]]);
  const button = Object.entries(settings.button_roles).map(([role, variable]) => [`button_${role}`, lookPalette[variable]]);
  const radii = Object.entries(settings.radius_roles).map(([role, variable]) => [`radius_${role}`, lookPalette[variable]]);
  return { ...Object.fromEntries([...colours, ...faces, ...button, ...radii]), scheme: lookScheme(lookPalette) === 'dark' ? 'dark' : 'light' };
}
// The worn look is read by `readLook`, which answers the look's palette ({ palette }), or null before the account has
// published a look. Before then an email is drawn in the shipped look, so no email waits on a publication; one whose
// published look cannot be read at all is not sent, and says so, never drawn in other colours.
export const BRAND_UNREAD = EMAIL_LOOK.brand_unread;
export const currentPalette = async (readLook = async () => null) => {
  try {
    const presentation = await readLook();
    if (presentation === null) return { palette: emailPalette(EMAIL_LOOK.shipped_palette) };
    if (presentation?.palette) return { palette: emailPalette(presentation.palette) };
  } catch (error) { console.error('worn email look unavailable:', error?.message ?? error); }
  return { error: BRAND_UNREAD };
};

/** One email drawn by the email part in the look's colours, with the account's mark (`brand`, its name and picture)
 * and its made-with line (`made_with`: label, href, image, alt), each when the account names one: { html, text }. */
export function drawEmail(message, brand = null, palette = emailPalette(), madeWith = null) {
  return emailMessageHtml({ ...message, brand: brand ?? {}, palette,
    ...(madeWith ? { made_with: { label: madeWith.label, href: madeWith.href, image: madeWith.image, alt: madeWith.alt } } : {}) });
}

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
