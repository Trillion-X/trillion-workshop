// src/workspace/upload.ts
//
// PURPOSE
//   Put files the person chose in their browser into their own Trillion space the same way every other uploader does
//   (tools/live-namespace/do-work/send-a-file-to-namespace-browser.mjs): content-defined chunks, each named by its BLAKE3
//   identity and checked on arrival, the file named in the folder the person is looking at the moment it starts, so
//   it opens and plays before it has finished.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A file is read by slices; it is never held whole in memory.
//   2. A chosen file goes in through the person's files operations (api.ts `files`: write_file_start, its pieces in
//      order, write_file_finish, files-door.mjs putFile), the same operations an AI asks;
//      the door names the file by the identity it works out itself. Every piece is sent (the door keeps a piece it
//      already holds once, but the page no longer skips sending it).
//   3. The account itself is reached only through this page's signed-in session (/work/api/...). The growing files below
//      (a recording still being made) still ask the retired growing routes; record-audio owns that path.
//   4. A refusal is shown as the Worker's words; nothing is reported as uploaded unless the Worker said it is stored.
//   5. A text document replaces a name only while it still holds what the editor opened (saveTextVersion). The identity
//      checked and the version protecting that write come from the same name row; a changed name is never overwritten.
//   6. A recording still being made goes in through `growingFiles` (the person's own session, the namespace's growing
//      files whose length is not known yet), and every refusal reaches the sender as a SendProblem saying whether to
//      send again, start again from the device copy, or stop and say why.

import { loadChunking } from '../../../../live-namespace/do-work/content-chunks-browser.mjs';
import { PlanNeeded, files, postJson, readJson } from './api';
import { putFile } from './files-door.mjs';
import { needsPlanTitle } from '../plan-needs.mjs';
import { SendProblem, type GrowingClient } from '../../../../record-audio/do-work/send-while-recording';
import { readOrMakePreview } from '../../../../ui/show/media-preview';
import { previewStore } from './made-previews';
import documents from './documents-words.json';
import failureWords from './failure-words.json';
// The chunker's compiled bytes, served under their content name (scripts/build-workspace.mjs).
import chunkingBytesAddress from 'trillion-workshop/tools/browse-and-upload-my-files/built-stored-bytes/content-chunks/content_chunks_bg.wasm';

import { partsProgress } from './upload-progress.mjs';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { sendProblemKind } from './send-problem-kind.mjs';
// The chunker, compiled once for this page and shared by every upload and every identity worked out here.
let chunker: ReturnType<typeof loadChunking> | null = null;
let chunking: Promise<ReturnType<typeof loadChunking>> | null = null;
const loadChunker = () => (chunking ??= WebAssembly.compileStreaming(fetch(chunkingBytesAddress)).then(module => (chunker = loadChunking({ module }))));

const sourceOf = (file: File) => ({
  size: file.size,
  readAt: async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
});

/** Upload files into `folder` ("/" or "/Trip"); `onProgress` hears each file's name and share done (0 to 1). */
export async function uploadFiles(files_: File[], folder: string, onProgress: (name: string, share: number) => void = () => {}) {
  const chosen = files_.filter(file => file.size).map(file => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { file, name: `${folder === '/' ? '' : folder}/${relative}` };
  });
  const names = [];
  for (const { file, name } of chosen) {
    let sent = 0;
    const kept = await putFile(files.change, {
      source: sourceOf(file), name, mediaType: file.type || null,
      onBytes: (bytes: number) => { sent += bytes; onProgress(file.name, partsProgress(sent, file.size)); },
    }) as { identity: string };
    // The local original is still in hand. Make its content-identified poster now, so the next gallery or device
    // reads a kept picture instead of opening the video to find its first frame.
    if (file.type.startsWith('video/') || /\.(?:mp4|mov|m4v|webm)$/i.test(file.name)) {
      const address = URL.createObjectURL(file);
      void readOrMakePreview(kept.identity, address, file.type.startsWith('video/') ? file.type : 'video/unknown', previewStore)
        .finally(() => URL.revokeObjectURL(address));
    }
    onProgress(file.name, 1);
    names.push({ name, identity: kept.identity, byte_length: file.size, modified_at_ms: file.lastModified });
  }
  return names;
}

/** How a request to the person's Files failed, as the sender acts on it: the plan or the request refused (stop and
 *  say why), the upload no longer open or its pieces numbered otherwise (start again from the device copy), or a
 *  failure in passing (busy, offline, a dropped connection: send again). */
function sendProblem(error: unknown): SendProblem {
  // A plan refusal is said as the plan's own title (what the plan lacks), never the Worker's words written for an AI.
  if (error instanceof PlanNeeded) return new SendProblem('refused', needsPlanTitle(error.upgrade_needed.feature?.id ?? null));
  const said = errorWords(error);
  const status = (error as { status?: unknown } | null)?.status;
  return new SendProblem(sendProblemKind(status), said);
}
const asked = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (error) { throw sendProblem(error); }
};

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The BLAKE3 identity of these bytes in order, read one piece at a time. */
export async function identityOf(pieces: Blob[]): Promise<string> {
  const chunking = chunker ?? await loadChunker();
  const whole = new chunking.Identity();
  try {
    for (const piece of pieces) whole.update(new Uint8Array(await piece.arrayBuffer()));
    return `1f:${whole.hex()}`;
  } finally {
    whole.free();
  }
}

/** The person's Files for a recording still being made: a file that grows while it is recorded and reads by its name
 *  from its first piece (src/namespace.mjs, `length_known: false`). */
export const growingFiles: GrowingClient = {
  start: input => asked(async () => (await postJson<{ growing: string }>('/work/api/namespace/growing', { ...input, length_known: false })).growing),
  piece: (upload, input) => asked(async () => { await postJson(`/work/api/namespace/growing/${encodeURIComponent(upload)}/pieces`, { piece: input.piece, offset: input.offset, content_base64: base64Of(input.bytes) }); }),
  finish: (upload, input) => asked(async () => (await postJson<{ file: { identity: string } }>(`/work/api/namespace/growing/${encodeURIComponent(upload)}/finish`, input)).file.identity),
  cancel: upload => asked(async () => { await readJson(`/work/api/namespace/growing/${encodeURIComponent(upload)}`, { method: 'DELETE' }); }),
  identity: identityOf,
};

/** Keeps `text` in the person's Files under `name` (a path), replacing what the name pointed at. */
export const keepText = (name: string, text: string) => files.change('write_file', { name, text, media_type: 'text/plain; charset=utf-8' }) as Promise<{ identity: string }>;

/** One name's identity and compare-and-set version from the same folder row. A missing name is null; a failed or
 *  incomplete read is never treated as a new name. */
async function nameSnapshot(name: string): Promise<{ identity: string; version: number } | null> {
  const folder = name.slice(0, name.lastIndexOf('/')) || '/';
  for (let after: string | undefined; ;) {
    const page = await files.read('list_files', { folder, limit: 500, ...(after ? { after } : {}) }) as { names: { name: string; identity: string; version: number }[]; next_after?: string | null };
    if (!page || !Array.isArray(page.names)) throw new Error(failureWords.broke);
    const found = page.names.find(row => row.name === name);
    if (found) {
      if (typeof found.identity !== 'string' || !found.identity || !Number.isSafeInteger(found.version) || found.version < 1) throw new Error(failureWords.broke);
      return { identity: found.identity, version: found.version };
    }
    if (!page.next_after) return null;
    after = page.next_after;
  }
}

/** Saves new immutable bytes only while the name still holds what the editor opened. Its identity and the version
 *  protecting the write come from one snapshot, so a concurrent writer's version can never authorize a stale edit. */
export async function saveTextVersion(name: string, text: string, expectedIdentity: string | null, mediaType = 'text/plain; charset=utf-8') {
  const current = await nameSnapshot(name);
  if ((current?.identity ?? null) !== expectedIdentity) throw new Error(documents.changed_elsewhere);
  // Namespace files have at least one byte; a visually empty document is kept as one line break.
  const file = new Blob([text || '\n'], { type: mediaType });
  try {
    const kept = await putFile(files.change, { source: sourceOf(file), name, mediaType, expectedVersion: current?.version ?? 0, onBytes: () => {} }) as { identity: string };
    return { identity: kept.identity, previous_identity: expectedIdentity };
  } catch (error) {
    // Refused or failed: only a successful read can establish that the name changed. Otherwise keep the actual refusal.
    let after: Awaited<ReturnType<typeof nameSnapshot>>;
    try { after = await nameSnapshot(name); } catch { throw error; }
    if ((after?.identity ?? null) !== expectedIdentity || after?.version !== current?.version) throw new Error(documents.changed_elsewhere);
    throw error;
  }
}

/** Takes names away from the person's Files into their set-aside names (the files stay reachable by their identity). */
export const removeNames = async (names: string[]) => {
  for (const name of names) await files.change('set_aside', { name });
};
