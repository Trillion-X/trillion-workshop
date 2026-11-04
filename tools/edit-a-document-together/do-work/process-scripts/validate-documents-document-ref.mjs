#!/usr/bin/env node
// Validate an owner-local address BEFORE a workflow direct-read can see it.
// This keeps foreign package records out of Documents publication memory.

import { writeFileSync } from 'node:fs';

const DOCUMENT_ADDRESS_PREFIX = 'package::documents::documents::';
const DOCUMENT_INDEX_ADDRESS_PREFIX = 'package::documents::document-index::';

export function validateDocumentsDocumentRef(documentRef) {
  if (typeof documentRef !== 'string' || !documentRef.startsWith(DOCUMENT_ADDRESS_PREFIX) || documentRef.length === DOCUMENT_ADDRESS_PREFIX.length) {
    throw new Error('document_ref must name a Documents canonical document address');
  }
  return {
    document_ref: documentRef,
    document_index_ref: `${DOCUMENT_INDEX_ADDRESS_PREFIX}${documentRef.slice(DOCUMENT_ADDRESS_PREFIX.length)}`,
  };
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const outputPath = valueOf(args, '--output-json') || 'validated-document-ref.json';
  try {
    const result = validateDocumentsDocumentRef(valueOf(args, '--document-ref'));
    writeFileSync(outputPath, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    const result = { ok: false, reason: error instanceof Error ? error.message : 'invalid document_ref' };
    writeFileSync(outputPath, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
