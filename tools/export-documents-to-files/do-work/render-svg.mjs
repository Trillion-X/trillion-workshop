// tools/export-documents-to-files/do-work/render-svg.mjs
//
// The svg renderer. A document that is one picture comes out as that picture, untouched. Anything else is laid out on
// pages (layout.mjs) and the pages are stacked in one SVG, text as <text>, tables as rules and shaded rows, pictures
// nested at their placed size.
import { layoutDocument } from './layout.mjs';

const xml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gray = value => { const level = Math.round(value * 255); return `rgb(${level},${level},${level})`; };
const fixed = value => Number(value.toFixed(2)).toString();

function itemMarkup(item, offset) {
  const y = item.y + offset;
  if (item.t === 'rect') return `<rect x="${fixed(item.x)}" y="${fixed(y)}" width="${fixed(item.w)}" height="${fixed(item.h)}" fill="${gray(item.gray)}"/>`;
  if (item.t === 'rule') return `<line x1="${fixed(item.x1)}" y1="${fixed(item.y1 + offset)}" x2="${fixed(item.x2)}" y2="${fixed(item.y2 + offset)}" stroke="${gray(item.gray)}" stroke-width="0.5"/>`;
  if (item.t === 'picture') return item.svg.replace(/<svg\b/, `<svg x="${fixed(item.x)}" y="${fixed(y)}" width="${fixed(item.w)}" height="${fixed(item.h)}"`);
  return `<text x="${fixed(item.x)}" y="${fixed(y)}" font-size="${fixed(item.size)}"${item.bold ? ' font-weight="bold"' : ''}${item.gray ? ` fill="${gray(item.gray)}"` : ''} xml:space="preserve">${xml(item.text)}</text>`;
}

/** @returns {string} the SVG file's text. */
export function renderSvg(document, { layout }, { size }) {
  const only = document.blocks.length === 1 && document.blocks[0].kind === 'picture' && !document.title;
  if (only) return `<?xml version="1.0" encoding="UTF-8"?>\n${document.blocks[0].svg.trim()}\n`;
  const { page, pages } = layoutDocument(document, layout, { strict: false, size });
  const gap = page.page_gap;
  const height = pages.length * page.height + (pages.length - 1) * gap;
  const body = pages.map((one, index) => {
    const offset = index * (page.height + gap);
    return `<g><rect x="0" y="${offset}" width="${page.width}" height="${page.height}" fill="#ffffff"/>${one.items.map(item => itemMarkup(item, offset)).join('')}</g>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${height}" viewBox="0 0 ${page.width} ${height}" font-family="Helvetica, Arial, sans-serif">\n<title>${xml(document.title)}</title>\n${body}\n</svg>\n`;
}
