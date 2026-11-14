// packages/structured-file-output/do-work/make-structured-file-output.ts
//
// Browser file byte creation for generic structured file output requests.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  capturedProcessFdText,
  decodeProcessResultWireShape,
  processExitedCode,
  type ProcessResultWireShape,
} from '@bitfield/runtime-kit/protocol';
import {
  readStructuredFileOutputFormats,
  safeStructuredFileStem,
  selectedStructuredFileOutputFormats,
  structuredFileOutputArtifactId,
  type StructuredFileOutputArtifactDescriptor,
  type StructuredFileOutputBlock,
  type StructuredFileOutputFormatDescriptor,
  type StructuredFileOutputFormatId,
  type StructuredFileOutputRequest,
  type StructuredFileOutputSection,
} from '@/packages/structured-file-output/read-data/structured-file-output';

export type StructuredFileOutputFile = StructuredFileOutputArtifactDescriptor & {
  bytes: Uint8Array;
};

export interface StructuredFileOutputSaveResult {
  files: StructuredFileOutputFile[];
  method: 'local-download-folder' | 'browser-download';
  paths: string[];
}

export type StructuredFileOutputTargetSender = (
  request: { target: string; payload: Record<string, unknown> },
) => Promise<unknown>;

type StructuredFileRenderer = {
  render(request: StructuredFileOutputRequest): Uint8Array;
};

const TEXT_ENCODER = new TextEncoder();
const COMPUTE_PROCESS_TARGET = 'compute.process';
const PROCESS_TIMEOUT_MS = 300_000;
const DOWNLOAD_MOUNT_PREFIX = 'structured-output-file-';
// Shared copy loop: expects `dest_dir` to already be set by the preamble that
// precedes it. Files arrive as (mounted source, target name) argument pairs.
const SAVE_LOOP = [
  'mkdir -p "$dest_dir"',
  'while [ "$#" -gt 0 ]; do',
  '  src="$1"',
  '  name="$2"',
  '  shift 2',
  '  base="${name%.*}"',
  '  ext="${name##*.}"',
  '  if [ "$base" = "$name" ]; then ext=""; fi',
  '  dest="$dest_dir/$name"',
  '  n=1',
  '  while [ -e "$dest" ]; do',
  '    if [ -n "$ext" ]; then dest="$dest_dir/$base ($n).$ext"; else dest="$dest_dir/$name ($n)"; fi',
  '    n=$((n + 1))',
  '  done',
  '  cp "$src" "$dest"',
  '  printf "%s\\n" "$dest"',
  'done',
].join('\n');
// The caller-supplied destination arrives as the FIRST positional argument —
// never interpolated into the script text, so no quoting/injection surface.
const SAVE_TO_PATH_SCRIPT = [
  'set -eu',
  'dest_dir="$1"',
  'shift',
  SAVE_LOOP,
].join('\n');
const DOWNLOAD_SCRIPT = [
  'set -eu',
  'download_dir="${XDG_DOWNLOAD_DIR:-}"',
  'if [ -z "$download_dir" ] && command -v xdg-user-dir >/dev/null 2>&1; then download_dir="$(xdg-user-dir DOWNLOAD 2>/dev/null || true)"; fi',
  'if [ -z "$download_dir" ] || [ "$download_dir" = "$HOME" ]; then download_dir="$HOME/Downloads"; fi',
  'dest_dir="$download_dir"',
  SAVE_LOOP,
].join('\n');

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function renderUtf8(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeStructuredFileOutputProcessReply(reply: unknown): ProcessResultWireShape {
  if (!reply || typeof reply !== 'object') throw new Error('compute.process returned no envelope.');
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload) || payload.constructor.name !== 'Uint8Array') {
    throw new Error('compute.process returned no byte payload.');
  }
  return decodeProcessResultWireShape(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
}

function requireProcessSuccess(result: ProcessResultWireShape, fallback: string): void {
  if (processExitedCode(result) === 0) return;
  const stderr = capturedProcessFdText(result, 2).trim();
  throw new Error(stderr.length > 0 ? stderr : fallback);
}

function sectionLines(section: StructuredFileOutputSection): string[] {
  return Array.isArray(section.lines) ? section.lines : [];
}

function sectionRows(section: StructuredFileOutputSection): string[][] {
  return Array.isArray(section.rows) ? section.rows : [];
}

function requestSections(request: StructuredFileOutputRequest): StructuredFileOutputSection[] {
  return request.sections.filter((section) => sectionLines(section).length > 0
    || sectionRows(section).length > 0 || (section.blocks?.length ?? 0) > 0);
}

function documentBlocks(section: StructuredFileOutputSection): StructuredFileOutputBlock[] {
  if (section.blocks) return section.blocks;
  return [
    ...sectionLines(section).map((text): StructuredFileOutputBlock => ({ kind: 'paragraph', text })),
    ...(sectionRows(section).length > 0 ? [{ kind: 'table', rows: sectionRows(section) } as const] : []),
  ];
}

function allRows(request: StructuredFileOutputRequest): string[][] {
  return requestSections(request).flatMap((section) => documentBlocks(section).flatMap((block) => {
    if (block.kind === 'heading' || block.kind === 'paragraph') return [[block.text]];
    if (block.kind === 'list') return block.items.map((item) => [item]);
    return block.rows;
  }));
}

function plainText(request: StructuredFileOutputRequest): string {
  const lines = [request.title];
  for (const section of requestSections(request)) {
    if (section.heading) lines.push('', section.heading);
    for (const block of documentBlocks(section)) {
      if (block.kind === 'heading') lines.push('', block.text);
      else if (block.kind === 'paragraph') lines.push(block.text);
      else if (block.kind === 'list') lines.push(...block.items.map((item) => `• ${item}`));
      else for (const row of block.rows) {
        if (row.length === 0) continue;
        const [label, ...values] = row;
        lines.push(values.length > 0 ? `${label}: ${values.join(' | ')}` : label);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br />');
}

function markdown(request: StructuredFileOutputRequest): string {
  const lines = [`# ${request.title}`, ''];
  for (const section of requestSections(request)) {
    if (section.heading) lines.push(`## ${section.heading}`, '');
    for (const block of documentBlocks(section)) {
      if (block.kind === 'heading') lines.push(`${'#'.repeat(Math.min(6, Math.max(1, block.level ?? 2)))} ${block.text}`, '');
      else if (block.kind === 'paragraph') lines.push(block.text, '');
      else if (block.kind === 'list') lines.push(...block.items.map((item) => `- ${item}`), '');
      else {
        const rows = block.rows;
        if (rows.length === 0) continue;
        const width = Math.max(...rows.map((row) => row.length), 2);
        const normalizedRows = rows.map((row) => [
          ...row,
          ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
        ]);
        lines.push(
          `| ${normalizedRows[0]?.map(escapeMarkdownCell).join(' | ') ?? 'Field | Value'} |`,
          `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
          ...normalizedRows.slice(1).map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
          '',
        );
      }
    }
  }
  return lines.join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csv(request: StructuredFileOutputRequest): string {
  return `${allRows(request).map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WORD_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function wordRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function wordParagraph(text: string, style?: string, numId?: number): string {
  const properties = [style ? `<w:pStyle w:val="${xmlEscape(style)}"/>` : '',
    numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : ''].join('');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${wordRun(text)}</w:p>`;
}

function wordTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const rowXml = rows.map((row) => `<w:tr>${Array.from({ length: width }, (_, index) => {
    const value = row[index] ?? '';
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${wordParagraph(value)}</w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/><w:left w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/><w:right w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="B7C9D6"/></w:tblBorders></w:tblPr>${rowXml}</w:tbl>`;
}

function docxDocumentXml(request: StructuredFileOutputRequest): string {
  const body = [wordParagraph(request.title, 'Title')];
  for (const section of requestSections(request)) {
    if (section.heading) body.push(wordParagraph(section.heading, 'Heading1'));
    for (const block of documentBlocks(section)) {
      if (block.kind === 'heading') {
        const depth = Math.min(6, Math.max(1, Math.trunc(block.level ?? 2)));
        body.push(wordParagraph(block.text, `Heading${depth}`));
      } else if (block.kind === 'paragraph') body.push(wordParagraph(block.text));
      else if (block.kind === 'list') {
        for (const item of block.items) body.push(wordParagraph(item, 'ListParagraph', 1));
      } else if (block.rows.length > 0) body.push(wordTable(block.rows));
    }
  }
  body.push('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}" xmlns:r="${WORD_REL_NS}"><w:body>${body.join('')}</w:body></w:document>`;
}

function docx(request: StructuredFileOutputRequest): Uint8Array {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>';
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${WORD_REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${WORD_REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${WORD_REL_NS}/numbering" Target="numbering.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>${Array.from({ length: 6 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="${index + 1}"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${32 - index * 2}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style></w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  return zipStore([
    { path: '[Content_Types].xml', bytes: renderUtf8(contentTypes) },
    { path: '_rels/.rels', bytes: renderUtf8(rootRels) },
    { path: 'word/document.xml', bytes: renderUtf8(docxDocumentXml(request)) },
    { path: 'word/_rels/document.xml.rels', bytes: renderUtf8(documentRels) },
    { path: 'word/styles.xml', bytes: renderUtf8(styles) },
    { path: 'word/numbering.xml', bytes: renderUtf8(numbering) },
  ]);
}

function pdfEscape(value: string): string {
  return value
    .replace(/[^\x20-\x7e\n]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLine(value: string, maxLength: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxLength && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [[]];
}

function pdf(request: StructuredFileOutputRequest): Uint8Array {
  const pageLines = chunk(plainText(request).split('\n').flatMap((line) => wrapLine(line, 88)), 42);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pageLines.forEach((page, index) => {
    const pageObjectId = 4 + index * 2;
    const contentObjectId = pageObjectId + 1;
    pageObjectIds.push(pageObjectId);
    objects[pageObjectId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    const content = [
      'BT',
      '/F1 11 Tf',
      '50 746 Td',
      '16 TL',
      ...page.map((line) => `(${pdfEscape(line)}) Tj T*`),
      'ET',
    ].join('\n');
    objects[contentObjectId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  const orderedObjects = objects.map((body, index) => ({ id: index, body })).filter((object) => object.id > 0 && object.body);
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of orderedObjects) {
    offsets[object.id] = output.length;
    output += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefOffset = output.length;
  const maxObjectId = Math.max(...orderedObjects.map((object) => object.id));
  output += `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f\n`;
  for (let id = 1; id <= maxObjectId; id += 1) {
    output += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n\n`;
  }
  output += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return renderUtf8(output);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let value = '';
  let current = index + 1;
  while (current > 0) {
    const mod = (current - 1) % 26;
    value = String.fromCharCode(65 + mod) + value;
    current = Math.floor((current - mod) / 26);
  }
  return value;
}

function worksheetXml(rows: string[][]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + rows.map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      return `<row r="${rowNumber}">${row.map((cell, cellIndex) => {
        const ref = `${columnName(cellIndex)}${rowNumber}`;
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
      }).join('')}</row>`;
    }).join('')
    + '</sheetData></worksheet>';
}

function uint16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const bytes of chunks) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}

function zipStore(entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const pathBytes = renderUtf8(entry.path);
    const checksum = crc32(entry.bytes);
    const localHeader = new Uint8Array([
      ...uint32(0x04034b50), ...uint16(20), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(checksum), ...uint32(entry.bytes.length), ...uint32(entry.bytes.length), ...uint16(pathBytes.length), ...uint16(0),
    ]);
    chunks.push(localHeader, pathBytes, entry.bytes);
    central.push(new Uint8Array([
      ...uint32(0x02014b50), ...uint16(20), ...uint16(20), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(checksum), ...uint32(entry.bytes.length), ...uint32(entry.bytes.length), ...uint16(pathBytes.length),
      ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0), ...uint32(0), ...uint32(offset),
    ]), pathBytes);
    offset += localHeader.length + pathBytes.length + entry.bytes.length;
  }
  const centralBytes = concatBytes(central);
  const end = new Uint8Array([
    ...uint32(0x06054b50), ...uint16(0), ...uint16(0), ...uint16(entries.length), ...uint16(entries.length),
    ...uint32(centralBytes.length), ...uint32(offset), ...uint16(0),
  ]);
  return concatBytes([...chunks, centralBytes, end]);
}

function xlsx(request: StructuredFileOutputRequest): Uint8Array {
  return zipStore([
    { path: '[Content_Types].xml', bytes: renderUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
    { path: '_rels/.rels', bytes: renderUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { path: 'xl/workbook.xml', bytes: renderUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Structured Output" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { path: 'xl/_rels/workbook.xml.rels', bytes: renderUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { path: 'xl/worksheets/sheet1.xml', bytes: renderUtf8(worksheetXml(allRows(request))) },
    { path: 'xl/styles.xml', bytes: renderUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>') },
  ]);
}

const RENDERERS: Record<StructuredFileOutputFormatId, StructuredFileRenderer> = {
  pdf: { render: pdf },
  docx: { render: docx },
  csv: { render: (request) => renderUtf8(csv(request)) },
  xlsx: { render: xlsx },
  markdown: { render: (request) => renderUtf8(markdown(request)) },
  txt: { render: (request) => renderUtf8(plainText(request)) },
};

function outputFileName(request: StructuredFileOutputRequest, format: StructuredFileOutputFormatDescriptor): string {
  return `${safeStructuredFileStem(request.fileStem || request.title)}.${format.extension}`;
}

export function makeStructuredFileOutput(
  request: StructuredFileOutputRequest,
  format: StructuredFileOutputFormatDescriptor,
): StructuredFileOutputFile | null {
  const renderer = RENDERERS[format.id];
  if (!renderer) return null;
  const bytes = renderer.render(request);
  return {
    id: structuredFileOutputArtifactId(request.requestId, format.id),
    requestId: request.requestId,
    formatId: format.id,
    fileName: outputFileName(request, format),
    mimeType: format.mimeType,
    byteLength: bytes.byteLength,
    bytes,
  };
}

export function makeStructuredFileOutputs(
  request: StructuredFileOutputRequest,
  formats = selectedStructuredFileOutputFormats(request, readStructuredFileOutputFormats()),
): StructuredFileOutputFile[] {
  return formats
    .map((format) => makeStructuredFileOutput(request, format))
    .filter((file): file is StructuredFileOutputFile => !!file);
}

export function structuredFileOutputArtifactDescriptors(
  files: readonly StructuredFileOutputFile[],
): StructuredFileOutputArtifactDescriptor[] {
  return files.map(({ bytes: _bytes, ...descriptor }) => descriptor);
}

function downloadStructuredFilesInBrowser(files: readonly StructuredFileOutputFile[]): void {
  if (typeof document === 'undefined' || !document.body) return;
  for (const file of files) {
    let link: HTMLAnchorElement | null = null;
    let url: string | null = null;
    try {
      const blob = new Blob([file.bytes], { type: file.mimeType });
      url = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      document.body.appendChild(link);
      if (typeof link.click === 'function') {
        link.click();
      }
    } catch {
      // Browser downloads are a best-effort handoff after bytes exist. The
      // browser does not expose a reliable completion callback to page code.
    } finally {
      try {
        link?.remove();
      } catch {
        link?.parentNode?.removeChild(link);
      }
      const revoke = () => {
        if (!url) return;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Object URL cleanup is best-effort after the browser handoff.
        }
      };
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(revoke, 1000);
      } else {
        revoke();
      }
    }
  }
}

export function buildStructuredFileOutputDownloadProcessRequest(files: readonly StructuredFileOutputFile[]) {
  return {
    target: COMPUTE_PROCESS_TARGET,
    payload: {
      argv: [
        'sh',
        '-lc',
        DOWNLOAD_SCRIPT,
        '--',
        ...files.flatMap((file, index) => [`${DOWNLOAD_MOUNT_PREFIX}${index}`, file.fileName]),
      ],
      cwd: null,
      timeout_ms: PROCESS_TIMEOUT_MS,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: files.map((file, index) => ({
        mount_path: `${DOWNLOAD_MOUNT_PREFIX}${index}`,
        source: {
          kind: 'inline',
          bytes: bytesToBase64(file.bytes),
        },
        content_type: file.mimeType,
      })),
      input_trees: [],
      outputs: [],
      containment: {
        kind: 'descendant_effect_contained',
        pipe_eof_timeout_ms: 1_000,
        publications: [],
      },
      capture_fds: [1, 2],
      collected_files: [],
    },
  };
}

export function buildStructuredFileOutputSaveToPathProcessRequest(
  files: readonly StructuredFileOutputFile[],
  destinationDir: string,
) {
  const dir = destinationDir.trim();
  if (!dir.startsWith('/')) {
    throw new Error('The folder to save into must be a full path starting with /');
  }
  return {
    target: COMPUTE_PROCESS_TARGET,
    payload: {
      argv: [
        'sh',
        '-lc',
        SAVE_TO_PATH_SCRIPT,
        '--',
        dir,
        ...files.flatMap((file, index) => [`${DOWNLOAD_MOUNT_PREFIX}${index}`, file.fileName]),
      ],
      cwd: null,
      timeout_ms: PROCESS_TIMEOUT_MS,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: files.map((file, index) => ({
        mount_path: `${DOWNLOAD_MOUNT_PREFIX}${index}`,
        source: {
          kind: 'inline',
          bytes: bytesToBase64(file.bytes),
        },
        content_type: file.mimeType,
      })),
      input_trees: [],
      outputs: [],
      containment: {
        kind: 'descendant_effect_contained',
        pipe_eof_timeout_ms: 1_000,
        publications: [],
      },
      capture_fds: [1, 2],
      collected_files: [],
    },
  };
}

export async function saveStructuredFilesToPath(
  files: readonly StructuredFileOutputFile[],
  destinationDir: string,
  sender: StructuredFileOutputTargetSender = sendRequestToBitfieldTarget,
): Promise<string[]> {
  const reply = await sender(buildStructuredFileOutputSaveToPathProcessRequest(files, destinationDir));
  const result = decodeStructuredFileOutputProcessReply(reply);
  requireProcessSuccess(result, 'Failed to save generated files.');
  const paths = capturedProcessFdText(result, 1).split('\n').map((line) => line.trim()).filter(Boolean);
  console.log(`[structured-file-output] wrote ${paths.length} file(s) to ${destinationDir} via compute.process`);
  return paths;
}

async function saveStructuredFilesToLocalDownloadFolder(
  files: readonly StructuredFileOutputFile[],
  sender: StructuredFileOutputTargetSender,
): Promise<string[]> {
  const reply = await sender(buildStructuredFileOutputDownloadProcessRequest(files));
  const result = decodeStructuredFileOutputProcessReply(reply);
  requireProcessSuccess(result, 'Failed to save generated files.');
  return capturedProcessFdText(result, 1).split('\n').map((line) => line.trim()).filter(Boolean);
}

export function downloadStructuredFileOutputs(
  request: StructuredFileOutputRequest,
  formats = selectedStructuredFileOutputFormats(request, readStructuredFileOutputFormats()),
): StructuredFileOutputFile[] {
  const files = makeStructuredFileOutputs(request, formats);
  downloadStructuredFilesInBrowser(files);
  return files;
}

export async function saveStructuredFileOutputs(
  request: StructuredFileOutputRequest,
  formats = selectedStructuredFileOutputFormats(request, readStructuredFileOutputFormats()),
  sender: StructuredFileOutputTargetSender = sendRequestToBitfieldTarget,
): Promise<StructuredFileOutputSaveResult> {
  const files = makeStructuredFileOutputs(request, formats);
  if (files.length === 0) {
    return { files, method: 'browser-download', paths: [] };
  }

  try {
    const paths = await saveStructuredFilesToLocalDownloadFolder(files, sender);
    return { files, method: 'local-download-folder', paths };
  } catch {
    downloadStructuredFilesInBrowser(files);
    return { files, method: 'browser-download', paths: [] };
  }
}

export function outputFormatIdsFromExtensions(extensions: readonly string[]): StructuredFileOutputFormatId[] {
  const formats = readStructuredFileOutputFormats();
  return extensions
    .map((extension) => formats.find((format) => format.extension === extension)?.id)
    .filter((id): id is StructuredFileOutputFormatId => !!id);
}

export function ensureStructuredFileOutputRequest(input: {
  requestId: string;
  title: string;
  fileStem?: string;
  formats: StructuredFileOutputFormatId[];
  sections: StructuredFileOutputSection[];
  source?: Record<string, unknown>;
  createdAt?: string;
}): StructuredFileOutputRequest {
  return {
    kind: 'structured-file-output.request',
    requestId: text(input.requestId, `structured-file-output:${Date.now().toString(36)}`),
    title: text(input.title, 'Structured file output'),
    fileStem: safeStructuredFileStem(input.fileStem ?? input.title),
    createdAt: input.createdAt ?? new Date().toISOString(),
    formats: input.formats,
    sections: input.sections,
    source: input.source,
  };
}
