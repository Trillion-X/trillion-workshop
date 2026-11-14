// packages/ui/show/file-preview/read-office-document.ts
//
// PURPOSE
//   Read an Office Open XML file (a Word document, an Excel workbook, a PowerPoint deck) in the browser into plain
//   structure FilePreview can draw: a document's paragraphs and tables, a workbook's sheets as rows of cell text, a
//   deck's slides as their lines of text. It is the browser's reading of the same containers the
//   `office-open-xml-decoder` package reads on a computer (its Python decoder also rewrites them; this file only reads).
//
// NON-NEGOTIABLE INVARIANTS
//   1. What the file is comes from the parts it holds (word/document.xml, xl/workbook.xml, ppt/presentation.xml),
//      never from its name or its media type.
//   2. Only the parts that are drawn are inflated; the zip's directory is read once from its end.
//   3. Inflating uses the browser's own DecompressionStream ('deflate-raw'); nothing is bundled for it.
//   4. What is drawn is bounded (rows, columns, paragraphs), and the answer says when it stopped early.
//   5. Anything unreadable throws; the caller shows the file card instead. Nothing is guessed.

export type OfficeBlock =
  | { readonly kind: 'paragraph'; readonly text: string; readonly heading: number | null }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] };

export type OfficeSheet = { readonly name: string; readonly rows: readonly (readonly string[])[]; readonly cut: boolean };

export type OfficeReading =
  | { readonly kind: 'document'; readonly blocks: readonly OfficeBlock[]; readonly cut: boolean }
  | { readonly kind: 'workbook'; readonly sheets: readonly OfficeSheet[] }
  | { readonly kind: 'presentation'; readonly slides: readonly (readonly string[])[] };

const LIMITS = { blocks: 4000, rows: 1000, columns: 60 };

// ── The zip container ──────────────────────────────────────────────────────
type Entry = { readonly method: number; readonly size: number; readonly offset: number };

function directory(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('This is not a zip container.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const entries = new Map<string, Entry>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The zip directory is damaged.');
    const nameLength = view.getUint16(at + 28, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

async function part(bytes: Uint8Array, entries: Map<string, Entry>, name: string): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const packed = bytes.slice(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(packed);
  if (entry.method !== 8) throw new Error('This file is packed in a way the browser cannot open.');
  const stream = new Response(packed).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// ── XML helpers (DOMParser, namespace-blind by local name) ─────────────────
const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const children = (node: Element, local: string) => Array.from(node.children).filter(child => child.localName === local);
const descendants = (node: Element | Document, local: string) => Array.from(node.getElementsByTagNameNS('*', local));
const attribute = (node: Element, local: string) => Array.from(node.attributes).find(item => item.localName === local)?.value ?? null;
// The relationship an element points at (`r:id`), never a same-named plain attribute such as a slide's own `id`.
const relationshipOf = (node: Element) => Array.from(node.attributes).find(item => item.localName === 'id' && (item.namespaceURI ?? '').endsWith('/relationships'))?.value ?? '';

// A paragraph's words: its runs' text, tabs and breaks in order.
function paragraphText(paragraph: Element): string {
  let text = '';
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.localName === 't') text += child.textContent ?? '';
      else if (child.localName === 'tab') text += '\t';
      else if (child.localName === 'br' || child.localName === 'cr') text += '\n';
      else if (child.localName !== 'pPr' && child.localName !== 'rPr') walk(child);
    }
  };
  walk(paragraph);
  return text;
}

// "Heading2" → 2, "Title" → 1; anything else is body text. The number is the style's own.
function headingOf(paragraph: Element): number | null {
  const style = descendants(paragraph, 'pStyle')[0];
  const name = style ? attribute(style, 'val') ?? '' : '';
  if (/^title$/i.test(name)) return 1;
  const match = /^heading\s*(\d)$/i.exec(name);
  return match ? Number(match[1]) : null;
}

function readDocument(text: string): OfficeReading {
  const body = descendants(xml(text), 'body')[0];
  if (!body) throw new Error('This document has no body.');
  const blocks: OfficeBlock[] = [];
  for (const node of Array.from(body.children)) {
    if (blocks.length >= LIMITS.blocks) return { kind: 'document', blocks, cut: true };
    if (node.localName === 'p') blocks.push({ kind: 'paragraph', text: paragraphText(node), heading: headingOf(node) });
    else if (node.localName === 'tbl') {
      blocks.push({ kind: 'table', rows: children(node, 'tr').slice(0, LIMITS.rows).map(row => children(row, 'tc').slice(0, LIMITS.columns).map(cell => children(cell, 'p').map(paragraphText).join('\n'))) });
    }
  }
  return { kind: 'document', blocks, cut: false };
}

// "AB12" → column index 27 (zero-based); a reference without letters is -1.
function columnOf(reference: string): number {
  let column = 0;
  for (const letter of reference.replace(/\d+$/, '').toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

// A relationship target, relative to its part's folder, as a path inside the zip.
function resolved(folder: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out: string[] = [];
  for (const piece of `${folder}/${target}`.split('/')) { if (piece === '..') out.pop(); else if (piece && piece !== '.') out.push(piece); }
  return out.join('/');
}

async function relationships(bytes: Uint8Array, entries: Map<string, Entry>, name: string, folder: string): Promise<Map<string, string>> {
  const text = await part(bytes, entries, name);
  const map = new Map<string, string>();
  if (!text) return map;
  for (const item of descendants(xml(text), 'Relationship')) {
    const id = attribute(item, 'Id');
    const target = attribute(item, 'Target');
    if (id && target) map.set(id, resolved(folder, target));
  }
  return map;
}

async function readWorkbook(bytes: Uint8Array, entries: Map<string, Entry>, workbook: string): Promise<OfficeReading> {
  const shared = await part(bytes, entries, 'xl/sharedStrings.xml');
  const strings = shared ? descendants(xml(shared), 'si').map(item => descendants(item, 't').map(node => node.textContent ?? '').join('')) : [];
  const links = await relationships(bytes, entries, 'xl/_rels/workbook.xml.rels', 'xl');
  const sheets: OfficeSheet[] = [];
  for (const sheet of descendants(xml(workbook), 'sheet')) {
    const target = links.get(relationshipOf(sheet));
    const text = target ? await part(bytes, entries, target) : null;
    if (!text) continue;
    const rows: string[][] = [];
    let cut = false;
    for (const row of descendants(xml(text), 'row')) {
      const at = Number(attribute(row, 'r') ?? rows.length + 1) - 1;
      if (at >= LIMITS.rows) { cut = true; break; }
      const cells: string[] = [];
      children(row, 'c').forEach((cell, position) => {
        const reference = attribute(cell, 'r');
        const column = reference ? columnOf(reference) : position;
        if (column >= LIMITS.columns) { cut = true; return; }
        if (column < 0) return;
        const type = attribute(cell, 't');
        const value = children(cell, 'v')[0]?.textContent ?? '';
        cells[column] = type === 's' ? strings[Number(value)] ?? ''
          : type === 'inlineStr' ? descendants(cell, 't').map(node => node.textContent ?? '').join('')
          : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE')
          : value;
      });
      while (rows.length < at) rows.push([]);
      rows[at] = Array.from(cells, item => item ?? '');
    }
    sheets.push({ name: attribute(sheet, 'name') ?? `Sheet ${sheets.length + 1}`, rows, cut });
  }
  return { kind: 'workbook', sheets };
}

async function readPresentation(bytes: Uint8Array, entries: Map<string, Entry>, presentation: string): Promise<OfficeReading> {
  const links = await relationships(bytes, entries, 'ppt/_rels/presentation.xml.rels', 'ppt');
  const slides: string[][] = [];
  for (const slide of descendants(xml(presentation), 'sldId')) {
    const target = links.get(relationshipOf(slide));
    const text = target ? await part(bytes, entries, target) : null;
    if (text) slides.push(descendants(xml(text), 'p').map(paragraphText).filter(line => line.trim().length > 0));
  }
  return { kind: 'presentation', slides };
}

/** Read one Office Open XML file's bytes into what FilePreview draws. Throws when it is not one. */
export async function readOfficeDocument(bytes: Uint8Array): Promise<OfficeReading> {
  const entries = directory(bytes);
  const document = await part(bytes, entries, 'word/document.xml');
  if (document) return readDocument(document);
  const workbook = await part(bytes, entries, 'xl/workbook.xml');
  if (workbook) return readWorkbook(bytes, entries, workbook);
  const presentation = await part(bytes, entries, 'ppt/presentation.xml');
  if (presentation) return readPresentation(bytes, entries, presentation);
  throw new Error('This file holds no document, workbook or presentation.');
}
