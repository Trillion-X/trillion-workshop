// tools/export-documents-to-files/do-work/render-pdf.mjs
//
// The pdf renderer: the laid-out pages (layout.mjs) as a complete PDF 1.4 file. Helvetica and Helvetica-Bold are the
// base-14 fonts every reader has, so nothing is embedded; text is written in Windows-1252 and the layout has already
// refused any character that set cannot draw. Content streams are deflated.
import { deflateSync } from 'node:zlib';
import { CODE_OF, layoutDocument } from './layout.mjs';

const fixed = value => Number(value.toFixed(2)).toString();

/** A literal string of Windows-1252 bytes, every byte outside printable ASCII as an octal escape. */
function literal(text) {
  let out = '';
  for (const ch of text) {
    const code = CODE_OF.get(ch);
    if (code === undefined) throw new Error(`The PDF cannot write ${JSON.stringify(ch)}.`);
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `(${out})`;
}

const utf16Hex = text => `<FEFF${[...text].map(ch => ch.codePointAt(0)).flatMap(point => (point > 0xffff ? [0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff)] : [point])).map(unit => unit.toString(16).padStart(4, '0')).join('')}>`;

function pageStream(items, pageHeight) {
  const flip = y => pageHeight - y;
  const lines = [];
  for (const item of items) {
    if (item.t === 'rect') lines.push(`${fixed(item.gray)} g ${fixed(item.x)} ${fixed(flip(item.y + item.h))} ${fixed(item.w)} ${fixed(item.h)} re f`);
    else if (item.t === 'rule') lines.push(`${fixed(item.gray)} G 0.5 w ${fixed(item.x1)} ${fixed(flip(item.y1))} m ${fixed(item.x2)} ${fixed(flip(item.y2))} l S`);
    else if (item.t === 'text') lines.push(`BT ${fixed(item.gray ?? 0)} g /${item.bold ? 'F2' : 'F1'} ${fixed(item.size)} Tf ${fixed(item.x)} ${fixed(flip(item.y))} Td ${literal(item.text)} Tj ET`);
    else throw new Error(`The PDF cannot draw a ${item.t}.`);
  }
  return Buffer.from(lines.join('\n'), 'latin1');
}

/** @returns {Buffer} the bytes of the PDF for `document`, laid out with the named page layout. */
export function renderPdf(document, { layout }, { size }) {
  const { page, pages } = layoutDocument(document, layout, { strict: true, size });
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const tree = add(null);
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${utf16Hex(document.title)} /Producer (Trillion Workshop) >>`);
  const kids = pages.map(one => {
    const body = deflateSync(pageStream(one.items, page.height));
    const content = add({ dictionary: `/Length ${body.length} /Filter /FlateDecode`, body });
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = typeof body === 'string'
      ? Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${index + 1} 0 obj\n<< ${body.dictionary} >>\nstream\n`, 'latin1'), body.body, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
