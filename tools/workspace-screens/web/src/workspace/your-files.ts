// src/workspace/your-files.ts
//
// PURPOSE
//   The person's own files as a file field's source (parts/ui/show/file-field): a folder read from the one namespace
//   listing (the files door's list_files, every page of it), and a dropped or uploaded file kept through the one
//   browser uploader (upload.ts) at the top of their files, as a file dropped on a file's own tab is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only files whose bytes are stored are offered, and of a file kept in several versions only the latest.
//   2. A file's id is its content identity (1f:...), the one every tool takes; a folder's id is its own path.
//   3. Nothing is reported uploaded unless the uploader answered it stored (upload.ts invariant 4).

import type { FileFieldEntry, FileFieldSource } from '../../parts/ui/show/file-field';
import { files, readJson, readListing } from './api';
import { baseName } from './file-picture';
import { uploadFiles } from './upload';
import { shareKeptFiles } from './share-kept-files.mjs';
import { filePages, sharedFileSource } from './shared-file-source.mjs';

type Listed = { name: string; identity: string | null; stored: boolean | null; media_type?: string | null; version?: { latest: boolean } };
type Listing = { names: Listed[]; folders: string[]; next_after: string | null };

const TOP = '/';
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const page = (folder: string, after: string, limit = 1000) => readListing<Listing>(folder, { limit, after });

type ContentPage = { identity: string; byte_length: number; offset: number; bytes_returned: number; encoding: 'utf-8' | 'base64'; content: string };

/** Read a bounded UTF-8 text file from the person's Files, verifying every
 * page and the final byte count before returning content to an importer. */
export async function readNamespaceText(identity: string, signal?: AbortSignal): Promise<string> {
  if (!/^1f:[a-f0-9]{64}$/.test(identity)) throw new Error('Choose a stored file first.');
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total: number | null = null;
  let pages = 0;
  while (total === null || offset < total) {
    if (++pages > 64) throw new Error('This file could not be read completely.');
    signal?.throwIfAborted();
    const current = await files.read('read_file', { name_or_identity: identity, offset, length: 262144 }) as ContentPage;
    if (current.identity !== identity || current.offset !== offset || !Number.isSafeInteger(current.byte_length)
        || current.byte_length < 0 || current.byte_length > MAX_TEXT_BYTES
        || !Number.isSafeInteger(current.bytes_returned) || current.bytes_returned < 0
        || !['utf-8', 'base64'].includes(current.encoding)) {
      throw new Error('This file is too large to import, or it changed while opening.');
    }
    if (total === null) total = current.byte_length;
    if (current.byte_length !== total || offset + current.bytes_returned > total) throw new Error('This file changed while opening.');
    const bytes = current.encoding === 'base64'
      ? Uint8Array.from(atob(current.content), value => value.charCodeAt(0))
      : new TextEncoder().encode(current.content);
    if (bytes.byteLength !== current.bytes_returned) throw new Error('This file could not be read completely.');
    if (bytes.byteLength) parts.push(bytes);
    offset += bytes.byteLength;
    if (offset < total && !bytes.byteLength) throw new Error('This file could not be read completely.');
  }
  const bytes = new Uint8Array(total ?? 0);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This is not a UTF-8 text file.'); }
}

async function list(folder: string): Promise<FileFieldEntry[]> {
  const first = await page(folder, '');
  const names = [...first.names];
  for (let after = first.next_after; after;) {
    const next = await page(folder, after);
    names.push(...next.names);
    after = next.next_after;
  }
  const folders = first.folders.map(path => ({ id: path, name: baseName(path), folder: true, path }));
  const files = names
    .filter(item => item.identity && item.stored !== false && item.version?.latest !== false)
    .map(item => ({ id: item.identity!, name: baseName(item.name), folder: false, media_type: item.media_type ?? null, path: item.name }));
  return [...folders, ...files];
}

async function upload(file: File, onProgress: (share: number) => void): Promise<FileFieldEntry> {
  const [kept] = await uploadFiles([file], TOP, (_name, share) => onProgress(share));
  if (!kept) throw new Error(`${file.name} is empty.`);
  return { id: kept.identity, name: baseName(kept.name), folder: false, media_type: file.type || null, path: kept.name };
}

/** The person's files, for every file field in the web app. */
export const yourFiles: FileFieldSource = { root: TOP, list, upload, pages: () => ({
  list: filePages((folder: string, after: string) => page(folder, after, 100), (listing: Listing, index: number) => [
    ...(index === 0 ? listing.folders.map(path => ({ id: path, name: baseName(path), folder: true, path })) : []),
    ...listing.names.filter(item => item.identity && item.stored !== false && item.version?.latest !== false)
      .map(item => ({ id: item.identity!, name: baseName(item.name), folder: false, media_type: item.media_type ?? null, path: item.name })),
  ], (listing: Listing) => listing.next_after),
}) };

/** Files for a schema-declared reference picker. Shared uploads are confirmed by the existing placement owner. */
export function referenceFiles(spaceId: unknown): FileFieldSource {
  return sharedFileSource({ spaceId, personal: yourFiles,
    read: (path: string) => readJson(path),
    share: (space: string, files: { identity: string; name?: string }[]) => shareKeptFiles(space, files,
      (path: string, body: Record<string, unknown>) => readJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true)),
  });
}
