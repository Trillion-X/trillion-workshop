// tools/export-documents-to-files/do-work/layout.mjs
//
// Lays a document out on pages: the one place text is measured, wrapped and paged, for every format that draws pages
// (pdf, svg). It returns positioned items; the writers only turn items into bytes.
//
//   layoutDocument(document, layoutName, { strict, size: { width, height } }) -> { page, pages: [{ items }] }
//   item = { t: 'text', x, y, size, bold, text, gray? } | { t: 'rect', x, y, w, h, gray } | { t: 'rule', x1, y1, x2, y2, gray }
//        | { t: 'picture', x, y, w, h, svg }       y runs down from the top of the page; `y` of text is its baseline.
//
// Text is measured with the Helvetica advance widths in read-data/helvetica-widths.json (Windows-1252, codes 32 to
// 255). `strict` (pdf) refuses a character outside that set and names it; otherwise (svg) such a character takes the
// width of an "n" and is written as it is.
import widthsData from '../read-data/helvetica-widths.json' with { type: 'json' };
import layoutsData from '../read-data/page-layouts.json' with { type: 'json' };
import { cellText, largest, numericColumns } from './document.mjs';

const FIRST_CODE = widthsData.first_code;
const NO_CHARACTER = new Set([127, 129, 141, 143, 144, 157]);
/** The character each Windows-1252 code draws, and the code each character is written as. */
export const CODE_OF = new Map();
for (let code = FIRST_CODE; code < 256; code += 1) {
  if (!NO_CHARACTER.has(code)) CODE_OF.set(code >= 128 && code < 160 ? [...widthsData.high_characters][code - 128] : String.fromCharCode(code), code);
}

const FALLBACK_WIDTH = widthsData.fonts.regular['n'.charCodeAt(0) - FIRST_CODE];

export const layoutNamed = name => layoutsData.layouts[name] ?? (() => { throw new Error(`There is no page layout ${JSON.stringify(name)} in read-data/page-layouts.json.`); })();

/** Words with one line break kind and no control characters. */
export function plainText(value) {
  return cellText(value).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
}

function measurer(strict, unsupported) {
  const width = (text, size, bold) => {
    let total = 0;
    for (const ch of text) {
      const code = CODE_OF.get(ch);
      if (code === undefined) {
        if (strict) unsupported.add(ch);
        total += FALLBACK_WIDTH;
      } else total += widthsData.fonts[bold ? 'bold' : 'regular'][code - FIRST_CODE];
    }
    return (total * size) / 1000;
  };
  /** Wraps `text` (which may hold line breaks) to lines no wider than `limit`; a word wider than that is cut. */
  const wrap = (text, size, bold, limit) => {
    const lines = [];
    for (const paragraph of plainText(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/ +/).filter(Boolean)) {
        const joined = line ? `${line} ${word}` : word;
        if (width(joined, size, bold) <= limit) { line = joined; continue; }
        if (line) { lines.push(line); line = ''; }
        let rest = word;
        while (width(rest, size, bold) > limit) {
          let cut = 1;
          while (cut < rest.length && width(rest.slice(0, cut + 1), size, bold) <= limit) cut += 1;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  };
  return { width, wrap };
}

function pictureSize(svg) {
  const open = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const box = open.match(/viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  const attr = name => Number(open.match(new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`))?.[1]);
  const [w, h] = box ? [Number(box[3]), Number(box[4])] : [attr('width'), attr('height')];
  if (!(w > 0) || !(h > 0)) throw new Error('A picture needs a viewBox, or a width and a height, to be placed on a page.');
  return { w, h };
}

export function layoutDocument(document, layoutName, { strict, size }) {
  const layout = layoutNamed(layoutName);
  const unsupported = new Set();
  const { width, wrap } = measurer(strict, unsupported);
  const page = { ...layout.page, width: size.width, height: size.height };
  const contentWidth = page.width - 2 * page.margin;
  const top = page.margin;
  const bottom = page.height - page.margin;
  const pages = [{ items: [] }];
  let y = top;

  const newPage = () => { pages.push({ items: [] }); y = top; };
  const room = height => bottom - y >= height;
  const ensure = height => { if (!room(height) && y > top) newPage(); };
  const put = item => pages.at(-1).items.push(item);
  const baseline = (at, size, lead) => at + (lead - size) / 2 + size * 0.8;

  /** Places wrapped lines one lead apart, paging between lines. */
  const placeLines = (lines, { x, size, lead, bold }) => {
    for (const text of lines) {
      ensure(lead);
      if (text) put({ t: 'text', x, y: baseline(y, size, lead), size, bold, text });
      y += lead;
    }
  };

  const placeText = (text, style, { x = page.margin, limit = contentWidth, keepWith = 0 } = {}) => {
    const lines = wrap(text, style.size, style.bold === true, limit);
    ensure(Math.min(lines.length, 1 + keepWith) * style.lead);
    placeLines(lines, { x, size: style.size, lead: style.lead, bold: style.bold === true });
  };

  const placeList = (items, ordered, depth) => {
    const { indent, bullets } = layout.list;
    items.forEach((item, index) => {
      const marker = ordered ? `${index + 1}.` : bullets[Math.min(depth, bullets.length - 1)];
      const x = page.margin + depth * indent;
      const lines = wrap(item.text, layout.body.size, false, contentWidth - (depth + 1) * indent);
      ensure(layout.body.lead);
      put({ t: 'text', x, y: baseline(y, layout.body.size, layout.body.lead), size: layout.body.size, bold: false, text: marker });
      placeLines(lines, { x: x + indent, size: layout.body.size, lead: layout.body.lead, bold: false });
      placeList(item.children, ordered, depth + 1);
    });
  };

  const placeTable = block => {
    const style = layout.table;
    if (block.title) {
      y += 2;
      placeText(block.title, { size: style.title_size, lead: style.title_lead, bold: true }, { keepWith: 3 });
    }
    const count = block.columns.length;
    if (count === 0) return;
    const header = block.columns.map(plainText);
    const rows = block.rows.map(row => row.map(plainText));
    // A column whose every filled cell is a number is written against its right edge, so digits line up.
    const numeric = numericColumns(block);
    const widest = (texts, size, bold) => largest(texts.flatMap(text => text.split('\n').map(line => width(line, size, bold))));
    const longestWord = (texts, size, bold) => largest(texts.flatMap(text => text.split(/\s+/).map(word => width(word, size, bold))));
    const column = (index, size, measure) => Math.max(measure([header[index]], size, true), measure(rows.map(row => row[index]), size, false));
    const avail = contentWidth;
    let size = style.size;
    // A column is never narrower than its header's longest word (a header is not broken mid-word), nor, up to word_share of the page, its data's longest word.
    const mins = () => block.columns.map((_, index) => Math.max(
      longestWord([header[index]], size, true) + 2 * style.pad,
      Math.min(longestWord(rows.map(row => row[index]), size, false) + 2 * style.pad, style.word_share * avail),
    ));
    while (mins().reduce((sum, value) => sum + value, 0) > avail && size > style.smallest_size) size -= 0.5;
    const lead = (style.lead * size) / style.size;
    const min = mins();
    const natural = block.columns.map((_, index) => Math.max(column(index, size, widest) + 2 * style.pad, min[index]));
    const sumNatural = natural.reduce((sum, value) => sum + value, 0);
    const sumMin = min.reduce((sum, value) => sum + value, 0);
    let widths;
    if (sumNatural <= avail) widths = natural.map(value => (value * avail) / sumNatural);
    else if (sumMin >= avail) widths = min.map(value => (value * avail) / sumMin);
    else widths = natural.map((value, index) => min[index] + ((value - min[index]) * (avail - sumMin)) / (sumNatural - sumMin));
    const lefts = widths.reduce((acc, value) => [...acc, acc.at(-1) + value], [page.margin]);

    const cellLines = (texts, bold) => texts.map((text, index) => wrap(text, size, bold, widths[index] - 2 * style.pad));
    const placeRow = (cells, bold, shade) => {
      const columns = cellLines(cells, bold);
      const total = largest(columns.map(lines => lines.length), 1);
      const perPage = Math.max(1, Math.floor((bottom - top - style.pad) / lead));
      for (let from = 0; from < total; from += perPage) {
        const slice = Math.min(perPage, total - from);
        const height = slice * lead + style.pad;
        if (!room(height)) { if (y > top) newPage(); }
        if (shade) put({ t: 'rect', x: page.margin, y, w: avail, h: height, gray: style.header_gray });
        columns.forEach((lines, index) => lines.slice(from, from + slice).forEach((text, offset) => {
          if (text) put({ t: 'text', x: !numeric[index] ? lefts[index] + style.pad : lefts[index] + widths[index] - style.pad - width(text, size, bold), y: baseline(y + style.pad / 2 + offset * lead, size, lead), size, bold, text });
        }));
        y += height;
        put({ t: 'rule', x1: page.margin, y1: y, x2: page.margin + avail, y2: y, gray: style.rule_gray });
      }
    };
    const placeHeader = () => placeRow(header, true, true);
    // The header and the first row stay together; a table that goes on to the next page repeats its header there.
    const firstHeight = lead * Math.max(1, ...cellLines(rows[0] ?? header, false).map(lines => lines.length)) + 2 * style.pad + lead;
    ensure(firstHeight + lead);
    placeHeader();
    for (const row of rows) {
      const needs = lead * Math.max(1, ...cellLines(row, false).map(lines => lines.length)) + style.pad;
      if (!room(needs) && y > top) { newPage(); placeHeader(); }
      placeRow(row, false, false);
    }
    y += style.after;
  };

  const placePicture = block => {
    if (block.title) placeText(block.title, { size: layout.table.title_size, lead: layout.table.title_lead, bold: true }, { keepWith: 1 });
    const natural = pictureSize(block.svg);
    const scale = Math.min(1, contentWidth / natural.w, (bottom - top) / natural.h);
    const [w, h] = [natural.w * scale, natural.h * scale];
    ensure(h);
    put({ t: 'picture', x: page.margin, y, w, h, svg: block.svg });
    y += h + layout.picture.after;
  };

  if (document.title) {
    placeText(document.title, layout.title);
    y += layout.title.after;
  }
  for (const block of document.blocks) {
    if (block.kind === 'heading') {
      const style = layout.heading[String(block.level)];
      if (y > top) y += style.before;
      placeText(block.text, style, { keepWith: 2 });
      y += style.after;
    } else if (block.kind === 'paragraph') {
      placeText(block.text, layout.body);
      y += layout.body.after;
    } else if (block.kind === 'list') {
      placeList(block.items, block.ordered, 0);
      y += layout.list.after;
    } else if (block.kind === 'table') placeTable(block);
    else if (block.kind === 'picture') placePicture(block);
    else throw new Error(`The page layout cannot place a ${block.kind} block.`);
  }

  if (strict && unsupported.size > 0) {
    throw new Error(`The PDF font (Helvetica, Windows-1252) cannot draw: ${[...unsupported].map(ch => `${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(', ')}. Nothing was substituted; export to Word, Markdown or HTML to keep these characters.`);
  }
  if (pages.length > 1 && layout.page_numbers) {
    const { size, from_bottom: fromBottom } = layout.page_numbers;
    pages.forEach((one, index) => {
      const text = `Page ${index + 1} of ${pages.length}`;
      one.items.push({ t: 'text', x: (page.width - width(text, size, false)) / 2, y: page.height - fromBottom, size, bold: false, text, gray: 0.4 });
    });
  }
  return { page, pages };
}
