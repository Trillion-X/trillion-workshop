// src/workspace/document-operations-transport.ts
//
// PURPOSE
//   The page's road to a document kept as operations in the person's store (src/native-workspace-records.mjs
//   applyDocumentOperations, answered at /work/api/records/document-operations through
//   src/own-resource-compatibility.mjs). It is the transport src/workspace/document-operation-sync.mjs is given.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A file's document is addressed by the BLAKE3 of its name, so every editor of that file meets in one record and
//      the name itself is never a saved-record label.
//   2. Refusals keep their HTTP status (readJson), which the session reads: 404 not kept yet, 409 changed meanwhile.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readJson } from './api';

const PATH = '/work/api/records/document-operations';
export const documentOperationsAddress = (name: string) => `file:${bytesToHex(blake3(new TextEncoder().encode(name)))}`;
const post = (path: string, body: unknown) => readJson<Record<string, unknown>>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const documentOperationsTransport = {
  read: ({ address, since }: { address: string; since?: number }) => readJson<Record<string, unknown>>(`${PATH}?${new URLSearchParams({ address, ...(since !== undefined ? { since: String(since) } : {}) })}`, { method: 'GET', cache: 'no-store' }),
  apply: (body: unknown) => post(PATH, body),
  remove: (body: unknown) => post(`${PATH}/remove`, body),
};
