// parts/ui/show/document-export/text-pdf.mjs
//
// PURPOSE
//   One pure writer that turns a titled list of text blocks into the bytes of a PDF (Helvetica, A4, wrapped and
//   paged). Every "Export PDF" and "Download PDF" on a note (transcript, summary, action items) goes through it, so
//   the page layout is solved once. It knows nothing about what the text means.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Output is a complete, valid PDF 1.4 byte string (header, objects, xref, trailer) for any input, including none.
//   2. Characters outside Latin-1 are written as "?" (the base-14 font cannot draw them); nothing throws.
//   3. Lines wrap by measured width (a Helvetica width estimate), never past the right margin, and pages break by count.

const PAGE = { width: 595, height: 842, margin: 56 };
const STYLES = {
  title: { size: 18, lead: 26, after: 10 },
  heading: { size: 13, lead: 20, after: 4 },
  body: { size: 11, lead: 16, after: 8 },
};
// Average Helvetica advance as a share of the font size; slightly wide so a line never overruns the margin.
const ADVANCE = 0.54;

const latin1 = text => String(text).replace(/\r\n?/g, '\n').replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?');
const escaped = text => text.replace(/[\\()]/g, '\\$&');

function wrap(text, size) {
  const limit = Math.floor((PAGE.width - 2 * PAGE.margin) / (size * ADVANCE));
  const lines = [];
  for (const paragraph of latin1(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      for (let rest = word; rest;) {
        const room = limit - (line ? line.length + 1 : 0);
        if (rest.length <= room) { line = line ? `${line} ${rest}` : rest; rest = ''; }
        else if (line) { lines.push(line); line = ''; }
        else { lines.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      }
    }
    lines.push(line);
  }
  return lines;
}

/** @param {{ title?: string, blocks: { heading?: string, text: string }[] }} document @returns {Uint8Array} */
export function textPdf({ title = '', blocks = [] }) {
  const placed = [];
  const add = (kind, text) => {
    const style = STYLES[kind];
    for (const line of wrap(text, style.size)) placed.push({ ...style, line });
    placed.push({ size: 0, lead: style.after, line: '' });
  };
  if (title) add('title', title);
  for (const block of blocks) { if (block.heading) add('heading', block.heading); if (block.text) add('body', block.text); }
  const pages = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const item of placed) {
    if (y - item.lead < PAGE.margin) { pages.push([]); y = PAGE.height - PAGE.margin; }
    y -= item.lead;
    if (item.line) pages[pages.length - 1].push({ ...item, y: y + (item.lead - item.size) / 2 });
  }
  const objects = [];
  const font = '3 0 R', bold = '4 0 R';
  const kids = pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((lines, index) => {
    const stream = lines.map(item => `BT /${item.size >= STYLES.heading.size ? 'F2' : 'F1'} ${item.size} Tf ${PAGE.margin} ${item.y.toFixed(1)} Td (${escaped(item.line)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${font} /F2 ${bold} >> >> /Contents ${6 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => { const at = out.length; out += `${index + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, ch => ch.charCodeAt(0));
}
