#!/usr/bin/env node
// import-content-document.mjs
//
// The blind adapter that turns produced content into an editable composition
// document plus a body-free index pointer. Any producer
// dispatches action:composition.import-document with { doc_id, title, ... } plus
// EITHER structured `sections` (preferred, lossless) OR a `body_html` string
// (the flattened body a producer already has). This script:
//   1. resolves an ordered list of generic sections (from `sections`, else by
//      parsing `body_html`, always led by the title as an H1),
//   2. maps sections -> a CompositionContent node tree (SAME rule as
//      read-data/document-sections.ts — heading levels reuse the format-bar
//      styles: h1 30/700, h2 22/600, h3 18/600, body 16/400),
//   3. emits BOTH records to write: the document at its own scene address and
//      the lightweight `composition-document-index` pointer (SAME shape as
//      read-data/document-index.ts).
// documents owns the document format + address convention here, so a
// producer never learns either (L098).
//
// Usage: node import-content-document.mjs --input-json '<json>' --output-json out.json

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildImportedDocument } from '../imported-document.mjs';
export {
  buildImportedDocument,
  verifyImportedDocument,
  exportCompositionDocument,
  importCompositionDocumentInterchange,
  importDocumentText,
  COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT,
  COMPOSITION_FRAGMENT_FORMAT,
} from '../imported-document.mjs';

function main() {
  const args = process.argv.slice(2);
  const inputPath = valueOf(args, '--input-json');
  const outputPath = valueOf(args, '--output-json') || 'import-document-result.json';
  const raw = inputPath?.startsWith('{') || inputPath?.startsWith('[')
    ? inputPath
    : (inputPath ? readFileSync(inputPath, 'utf8') : '{}');
  const input = JSON.parse(raw || '{}');
  // Only the import process supplies wall-clock time. The shared mapper is also
  // used by the read-only verifier and must stay deterministic.
  const result = buildImportedDocument({
    ...input,
    updated_at: typeof input.updated_at === 'string' && input.updated_at
      ? input.updated_at : new Date().toISOString(),
  });
  writeFileSync(outputPath, JSON.stringify(result));
  process.stdout.write(JSON.stringify(result));
  return result.ok ? 0 : 2;
}

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
