import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { importMarkdownDocument, exportDocumentMarkdown, revisionHashFor } from './imported-document.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 500_000;
const MAX_RESULT_BYTES = 240_000;
const encoder = new TextEncoder();

export function importMarkdown(markdown, requestedId, { maxResultBytes = MAX_RESULT_BYTES } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new TypeError('Markdown text is required.');
  const sourceBytes = encoder.encode(markdown);
  if (sourceBytes.byteLength > MAX_INPUT_BYTES) throw new Error(`Markdown exceeds the ${MAX_INPUT_BYTES}-byte import limit.`);
  const sourceIdentity = makeHashCodeHexFromBytes(sourceBytes);
  const pageId = typeof requestedId === 'string' && requestedId.trim() ? requestedId.trim() : `markdown-${sourceIdentity.slice(3, 19)}`;
  const imported = importMarkdownDocument(markdown, pageId, { includeSourceProvenance: true });
  const spans = imported.source_provenance;
  if (!Array.isArray(spans) || spans.length !== imported.block_count) throw new Error('Importer did not return provenance for every visible editable block.');
  for (const { source_block: span } of spans) {
    if (!span || !Number.isSafeInteger(span.byte_start) || !Number.isSafeInteger(span.byte_end)
      || span.byte_start < 0 || span.byte_end <= span.byte_start || span.byte_end > sourceBytes.byteLength) {
      throw new Error('Importer returned an invalid UTF-8 source byte span.');
    }
    const sourceSlice = sourceBytes.subarray(span.byte_start, span.byte_end);
    if (makeHashCodeHexFromBytes(sourceSlice) !== makeHashCodeHexFromBytes(encoder.encode(span.text))) {
      throw new Error('Importer source byte span does not match its recorded token text.');
    }
  }
  const canonical = exportDocumentMarkdown(imported.page);
  const roundTrip = importMarkdownDocument(canonical, pageId, { includeSourceProvenance: false });
  if (revisionHashFor(roundTrip.page) !== revisionHashFor(imported.page)) {
    throw new Error('Editable scene tree changed during the maintained Markdown export/import round trip.');
  }
  const result = {
    kind: 'editable-document-import', page: imported.page, block_count: imported.block_count,
    source_identity: sourceIdentity, source_byte_length: sourceBytes.byteLength,
    source_provenance: spans, canonical_markdown: canonical, round_trip: 'passed',
  };
  const resultBytes = encoder.encode(JSON.stringify(result)).byteLength;
  if (resultBytes > maxResultBytes) throw new Error(`Editable result exceeds ${maxResultBytes} bytes; use the file adapter for large documents.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let rawInput = '';
  for await (const chunk of process.stdin) rawInput += chunk;
  try {
    const input = JSON.parse(rawInput);
    const result = importMarkdown(input.markdown, input.document_id);
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
