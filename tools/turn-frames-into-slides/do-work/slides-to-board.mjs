// tools/turn-frames-into-slides/do-work/slides-to-board.mjs
//
// Lays out a deck written as slides (what each slide says and shows) onto a board of presentation frames, so a deck
// workflow hands over words and pictures and never places items by hand. make-slides reads a request's `slides` with
// this, then judges and draws the board as it does any other.
//
// slides: { size?: { width, height } (default 1920 x 1080), roles?: { paper, ink, accent, card, display, body }
//           (look variable names; defaults --bg-primary, --ink, --accent-primary, --bg-surface, --font-display,
//           --font-primary: the names the Screen Look's palette has, read-data/resolve-screen-look-palette.js),
//           list: [slide] }
// slide, by its kind:
//   words    { title, lines?: [text], dark?, cover? }         a title and its lines; cover sets the title larger
//   compare  { title, lines?: [text], columns: [{ head, note?, body }] }   side by side, 2 to 4 columns
//   picture  { title, picture: asset name or file, caption? }  one screenshot, fitted whole
//   table    { title, head: [text], rows: [[text]], widths?: [parts], lines?: [text] }
// A picture that is not "asset:<name>" is added to the request's assets under the slide's own name.
const KINDS = new Set(['words', 'compare', 'picture', 'table']);
const DEFAULT_ROLES = { paper: '--bg-primary', ink: '--ink', accent: '--accent-primary', card: '--bg-surface', display: '--font-display', body: '--font-primary' };
const GAP = 200;

const plain = { fill: 'none', stroke: 'none' };

// The board's own wrapping (organize-the-sidebar board-svg.ts wrapLines): an 8 px inset each side, a line of
// floor(inner width / (size x charWidth)) characters broken at the last space. Each text item is sized by the same rule and
// carries its charWidth, so the drawn words always fit the box this lays out and are never cut short with an ellipsis.
const INSET = 8;
const CHAR_WIDTH = 0.55;

function lineCount(text, size, width, charWidth = CHAR_WIDTH) {
  const perLine = Math.max(1, Math.floor((width - INSET * 2) / (size * charWidth)));
  let lines = 0;
  for (const raw of String(text).split('\n')) {
    let rest = raw.trimEnd();
    if (!rest) { lines += 1; continue; }
    while (rest.length) {
      lines += 1;
      if (rest.length <= perLine) break;
      let cut = rest.lastIndexOf(' ', perLine);
      if (cut <= 0) cut = perLine;
      rest = rest.slice(cut).trimStart();
    }
  }
  return lines;
}

function heightOf(text, size, width, lineHeight) {
  return Math.ceil(lineCount(text, size, width) * size * lineHeight) + INSET + 6;
}

function textItem(memberId, x, y, w, text, size, roles, { weight = 400, display = false, color = roles.ink, lineHeight = 1.35, h } = {}) {
  return {
    memberId, x, y, w, h: h ?? heightOf(text, size, w, lineHeight), text,
    extra: { fontSize: size, fontWeight: weight, lineHeight, charWidth: CHAR_WIDTH, textInset: INSET, fontFamily: display ? roles.display : roles.body, style: { ...plain, textColor: color } },
  };
}

function boxItem(memberId, x, y, w, h, fill) {
  return { memberId, x, y, w, h, text: '', extra: { style: { fill, stroke: fill, cornerRadius: 12 } } };
}

function stack(items, startY, gap) {
  let y = startY;
  for (const item of items) {
    item.y = y;
    y += item.h + gap;
  }
  return y;
}

function words(slide, id, ox, size, roles, ink) {
  const left = ox + 120, width = size.width - 240;
  const titleSize = slide.cover ? 92 : 64;
  const title = textItem(`${id}-title`, left, 0, width, slide.title, titleSize, roles, { weight: 600, display: true, color: ink, lineHeight: 1.15 });
  const lines = (slide.lines ?? []).map((line, index) => textItem(`${id}-line-${index + 1}`, left, 0, width, line, 36, roles, { color: ink }));
  stack([title], slide.cover ? 150 : 110, 0);
  stack(lines, title.y + title.h + 50, 22);
  return [title, ...lines];
}

function compare(slide, id, ox, size, roles, ink) {
  const columns = slide.columns ?? [];
  if (columns.length < 2 || columns.length > 4) throw new Error(`slide ${id} compares ${columns.length} columns; give 2 to 4.`);
  const left = ox + 80, width = size.width - 160, gap = 24;
  const title = textItem(`${id}-title`, left, 70, width, slide.title, 56, roles, { weight: 600, display: true, color: ink, lineHeight: 1.1 });
  const lines = (slide.lines ?? []).map((line, index) => textItem(`${id}-line-${index + 1}`, left, 0, width, line, 28, roles, { color: ink }));
  const top = stack(lines, title.y + title.h + 12, 8) + 16;
  const columnWidth = Math.floor((width - gap * (columns.length - 1)) / columns.length);
  const heads = columns.map((column, index) => textItem(`${id}-col-${index + 1}-head`, left + index * (columnWidth + gap), top, columnWidth, column.head, 26, roles, { weight: 600, color: ink, lineHeight: 1.2 }));
  const boxTop = top + Math.max(...heads.map(head => head.h)) + 12;
  const boxHeight = size.height - boxTop - 50;
  const items = [title, ...lines, ...heads];
  columns.forEach((column, index) => {
    const x = left + index * (columnWidth + gap);
    items.push(boxItem(`${id}-col-${index + 1}-card`, x, boxTop, columnWidth, boxHeight, roles.card));
    let y = boxTop + 22;
    if (column.note) {
      const note = textItem(`${id}-col-${index + 1}-note`, x + 22, y, columnWidth - 44, column.note, 22, roles, { weight: 600, color: roles.accent, lineHeight: 1.3 });
      items.push(note);
      y += note.h + 14;
    }
    items.push(textItem(`${id}-col-${index + 1}-body`, x + 22, y, columnWidth - 44, column.body, column.size ?? 19, roles, { color: ink, lineHeight: 1.4, h: boxTop + boxHeight - y - 16 }));
  });
  return items;
}

function picture(slide, id, ox, size, roles, ink, assets) {
  const left = ox + 96, width = size.width - 192;
  const title = textItem(`${id}-title`, left, 60, width, slide.title, 56, roles, { weight: 600, display: true, color: ink, lineHeight: 1.1 });
  const top = title.y + title.h + 20;
  const caption = slide.caption ? textItem(`${id}-caption`, left, 0, width, slide.caption, 28, roles, { color: ink }) : null;
  const bottom = size.height - 50 - (caption ? caption.h + 16 : 0);
  let src = String(slide.picture ?? '');
  if (!src) throw new Error(`slide ${id} is a picture slide with no picture.`);
  if (!src.startsWith('asset:')) {
    assets[`${id}-picture`] = src;
    src = `asset:${id}-picture`;
  }
  const items = [title, { memberId: `${id}-picture`, x: left, y: top, w: width, h: bottom - top, src, extra: { imageFit: 'contain', style: plain } }];
  if (caption) {
    caption.y = bottom + 16;
    items.push(caption);
  }
  return items;
}

function table(slide, id, ox, size, roles, ink) {
  const left = ox + 120, width = size.width - 240;
  const title = textItem(`${id}-title`, left, 90, width, slide.title, 60, roles, { weight: 600, display: true, color: ink, lineHeight: 1.1 });
  const parts = slide.widths ?? slide.head.map(() => 1);
  const total = parts.reduce((sum, part) => sum + part, 0);
  const widths = parts.map(part => Math.floor((width * part) / total));
  const items = [title];
  let y = title.y + title.h + 40;
  [slide.head, ...slide.rows].forEach((row, r) => {
    const cells = row.map((cell, c) => textItem(`${id}-row-${r}-cell-${c + 1}`, left + widths.slice(0, c).reduce((s, w) => s + w, 0), y, widths[c] - 24, cell,
      r ? 26 : 24, roles, { weight: r === 0 || c === 0 ? 600 : 400, color: ink, lineHeight: 1.3 }));
    const rowHeight = Math.max(...cells.map(cell => cell.h)) + 20;
    if (r) items.push(boxItem(`${id}-row-${r}-band`, left - 16, y - 10, width + 32, rowHeight - 4, roles.card));
    items.push(...cells);
    y += rowHeight + 6;
  });
  const lines = (slide.lines ?? []).map((line, index) => textItem(`${id}-line-${index + 1}`, left, 0, width, line, 24, roles, { color: ink }));
  stack(lines, y + 20, 10);
  return [...items, ...lines];
}

/** slides -> { items, assets }: one presentation frame per slide, side by side on the board, in the list's order. */
export function slidesToBoard(slides) {
  const list = Array.isArray(slides) ? slides : slides?.list;
  if (!Array.isArray(list) || !list.length) throw new Error('slides is a list of slides, or { list }.');
  const size = { width: 1920, height: 1080, ...(slides.size ?? {}) };
  const roles = { ...DEFAULT_ROLES, ...(slides.roles ?? {}) };
  const items = [];
  const assets = {};
  list.forEach((slide, index) => {
    const kind = slide.kind ?? 'words';
    if (!KINDS.has(kind)) throw new Error(`slide ${index + 1} is of kind ${kind}; a slide is words, compare, picture or table.`);
    if (typeof slide.title !== 'string' || !slide.title.trim()) throw new Error(`slide ${index + 1} has no title.`);
    const id = `s${index + 1}`;
    const ox = index * (size.width + GAP);
    const ink = slide.dark ? roles.paper : roles.ink;
    items.push({ memberId: id, x: ox, y: 0, w: size.width, h: size.height, text: '',
      extra: { presentationFrame: { order: index + 1 }, style: { fill: slide.dark ? roles.ink : roles.paper, stroke: 'none' } } });
    if (kind === 'words') items.push(...words(slide, id, ox, size, roles, ink));
    if (kind === 'compare') items.push(...compare(slide, id, ox, size, roles, ink));
    if (kind === 'picture') items.push(...picture(slide, id, ox, size, roles, ink, assets));
    if (kind === 'table') items.push(...table(slide, id, ox, size, roles, ink));
  });
  return { items, assets };
}
