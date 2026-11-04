#!/usr/bin/env node
// read-document-publication-snapshot.mjs
//
// Documents is the sole owner of an editable body. This mapper receives that
// body only after the Documents workflow has read its canonical address, then
// returns a stable BLAKE3 multihash basis for an effect owner. Callers cannot
// supply a hash: a later edit necessarily produces a different snapshot hash.

import { blake3 } from '@noble/hashes/blake3.js';
import { readFileSync, writeFileSync } from 'node:fs';

const DOCUMENT_ADDRESS_PREFIX = 'package::documents::documents::';

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function publicationSnapshot(documentRef, body, index) {
  if (typeof documentRef !== 'string' || !documentRef.startsWith(DOCUMENT_ADDRESS_PREFIX) || documentRef.length === DOCUMENT_ADDRESS_PREFIX.length) {
    throw new Error('document_ref must name a Documents canonical document address');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('canonical document body is missing or malformed');
  }
  // workflow-core decodes a JSON direct-read into the original payload and
  // appends its transport-level content_hash. It is not authored document
  // content, and Documents scenes never permit that top-level field.
  const canonicalBody = { ...body };
  delete canonicalBody.content_hash;
  if (!Array.isArray(canonicalBody.children)) {
    throw new Error('canonical document body must be a composition scene');
  }
  const documentRevisionHash = `1f:${Buffer.from(blake3(new Uint8Array(Buffer.from(stableJson(canonicalBody))))).toString('hex')}`;
  // Older/manual Documents scenes predate the optional library pointer.  They
  // are still canonical Documents bodies and may publish.  When an index is
  // present, it must name this exact scene and may not claim another revision.
  const hasIndex = index && typeof index === 'object' && !Array.isArray(index);
  if (hasIndex && (index.kind !== 'composition-document-index' || index.doc_address !== documentRef)) {
    throw new Error('canonical Documents index does not belong to document_ref');
  }
  // Publishing is the effect command. A separate mutable confirmation state
  // would add ceremony without adding safety.
  // The owner-computed hash is the predicate: an edit changes it, so an old
  // Publish command cannot apply to new content.
  if (hasIndex && typeof index.document_revision_hash === 'string'
    && index.document_revision_hash
    && index.document_revision_hash !== documentRevisionHash) {
    throw new Error('Documents index no longer matches the current editable body');
  }
  return {
    document_ref: documentRef,
    document_revision_hash: documentRevisionHash,
    // This is an ephemeral owner readback for the delivery formatter. Consumers
    // may transform it, but Content Distribution must never persist another body.
    body_ref: documentRef,
    body: canonicalBody,
    status: hasIndex && typeof index.status === 'string' ? index.status : 'draft',
  };
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const documentRef = valueOf(args, '--document-ref');
  const bodyJson = valueOf(args, '--body-json');
  const indexJson = valueOf(args, '--index-json');
  const outputPath = valueOf(args, '--output-json') || 'document-publication-snapshot.json';
  try {
    const result = publicationSnapshot(documentRef, JSON.parse(bodyJson ?? 'null'), JSON.parse(indexJson ?? 'null'));
    writeFileSync(outputPath, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    const result = { ok: false, reason: error instanceof Error ? error.message : 'could not read document publication snapshot' };
    writeFileSync(outputPath, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

export { publicationSnapshot, stableJson };
