// parts/ui/show/clipboard/answer-copy.mjs
//
// A COPIED ANSWER KEEPS ITS SOURCES: EVERY TIME CITATION BECOMES A LINK THAT OPENS THE SOURCE AT THAT SECOND.
//
// Purpose: an AI answer about a recording says where it got things: `[1:02]`. Pasted elsewhere those are just numbers. This turns a
// copied answer into two halves, one with each citation as a link and a plain one where each is followed by the address, so
// whoever reads it elsewhere can go to the exact moment, and nothing but the answer is carried.
//
// Non-negotiable invariants:
//   1. Pure: text in, `{ html, text }` out. The source's address (`base`) is handed in; without one, citations stay as written.
//   2. Every link address is the source's own, or an https address the answer itself wrote; anything else (a script address, a
//      relative path that is not site-absolute) is written as plain words and never as a link.
//   3. Text is escaped by the one markup writer (../server-rendered-page/markup-tree.mjs); this file writes no markup by hand.
//   4. Patterns, the bullet, the dropped lines and the link parameter are DATA (./answer-copy.json).
//
// Key concept: `answerForClipboard(answer, { base })` -> { html, text }.
import rules from './answer-copy.json' with { type: 'json' };
import { element, serialise, textOf } from 'trillion-workshop/tools/write-a-post-for-each-place/read-data/markup-tree.mjs';

/** Seconds in a clock reading: `1:02` is 62, `1:02:03` is 3723. */
export function clockSeconds(clock) {
  return clock.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

/** The source's own address opened at `seconds` (the one form a pasted citation and a copied moment both use). */
export const linkTo = (base, seconds, settings = rules) => `${base}${base.includes('?') ? '&' : '?'}${settings.link.param}=${seconds}`;
const anchor = (href, words) => element('a', { href }, [textOf(words)]);

/** The inline pieces of one line: text, bold, links, frames and citations, as { nodes, text } in reading order. */
function inline(line, base, settings) {
  const safe = new RegExp(settings.safe_link, 'u');
  const citation = settings.citations.map((row) => row.pattern).join('|');
  const pattern = new RegExp(`${settings.frames.pattern}|\\*\\*([^*]+)\\*\\*|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)|${citation}`, 'gu');
  const nodes = [];
  let text = '';
  let from = 0;
  const plain = (value) => { if (value) { nodes.push(textOf(value)); text += value; } };
  for (const match of line.matchAll(pattern)) {
    plain(line.slice(from, match.index));
    from = match.index + match[0].length;
    const [, frameAlt, frameClock, bold, linkText, linkHref, cited] = match;
    if (frameClock !== undefined) {
      const words = frameAlt || frameClock;
      if (base) { const href = linkTo(base, clockSeconds(frameClock), settings); nodes.push(anchor(href, words)); text += `${words} (${href})`; } else plain(words);
    } else if (bold !== undefined) {
      nodes.push(element('strong', {}, [textOf(bold)])); text += bold;
    } else if (linkText !== undefined) {
      if (safe.test(linkHref)) { nodes.push(anchor(linkHref, linkText)); text += `${linkText} (${linkHref})`; } else plain(linkText);
    } else if (cited !== undefined && base) {
      const clocks = cited.split(',').map((clock) => clock.trim());
      nodes.push(textOf('['));
      clocks.forEach((clock, index) => {
        if (index) nodes.push(textOf(', '));
        nodes.push(anchor(linkTo(base, clockSeconds(clock), settings), clock));
      });
      nodes.push(textOf(']'));
      text += `[${clocks.map((clock) => `${clock} (${linkTo(base, clockSeconds(clock), settings)})`).join(', ')}]`;
    } else plain(match[0]);
  }
  plain(line.slice(from));
  return { nodes, text };
}

/** The answer as marked-up text and plain text, each time citation linked to the source's moment. `base` is the source's address. */
export function answerForClipboard(answer, { base = null } = {}, settings = rules) {
  const dropped = settings.drop_lines.map((pattern) => new RegExp(pattern, 'u'));
  const lines = String(answer).split(/\r?\n/u).filter((line) => !dropped.some((test) => test.test(line)));
  const blocks = [];
  const plain = [];
  let list = null;
  for (const raw of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/u.exec(raw);
    const heading = /^\s*#{1,6}\s+(.*)$/u.exec(raw);
    if (bullet) {
      const made = inline(bullet[1], base, settings);
      if (!list) { list = element('ul', {}, []); blocks.push(list); }
      list.children.push(element('li', {}, made.nodes));
      plain.push(`${settings.bullet} ${made.text}`);
      continue;
    }
    list = null;
    if (!raw.trim()) { if (plain.at(-1) !== '') plain.push(''); continue; }
    const made = inline(heading ? heading[1] : raw.trim(), base, settings);
    blocks.push(element('p', {}, heading ? [element('strong', {}, made.nodes)] : made.nodes));
    plain.push(made.text);
  }
  while (plain.at(-1) === '') plain.pop();
  return { html: blocks.map(serialise).join(''), text: plain.join('\n') };
}

/** The address of the source a message is about, from the files attached to it or its own text (DATA `source`), or null. */
export function sourceBaseOf(message, settings = rules) {
  for (const row of settings.source.from) {
    const pattern = new RegExp(row.pattern, 'u');
    const candidates = row.in === 'files' ? (Array.isArray(message?.files) ? message.files.map(file => file?.[row.field]) : []) : [message?.content];
    for (const candidate of candidates) {
      const found = typeof candidate === 'string' ? pattern.exec(candidate) : null;
      if (found) return settings.source.base.replace('{id}', encodeURIComponent(decodeURIComponent(found[1])));
    }
  }
  return null;
}
