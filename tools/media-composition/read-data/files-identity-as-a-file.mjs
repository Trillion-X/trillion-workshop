// tools/media-composition/read-data/files-identity-as-a-file.mjs
//
// Purpose
//   Hands one of the person's files, named by its identity (1f: then 64 hex), to a program on this computer as a file path.
//   A program cannot open an identity, so the run's host reads the file a page at a time (read_file with offset and length,
//   the run's files right) and each page is written to one private file in a folder made for this run. The program reads
//   that file by its path; the folder is removed when the program is done, whatever happened.
//
// Non-Negotiable Invariants
//   1. A file larger than most_bytes (files-identity-as-a-file.json) is refused before its first page is written, with the
//      size named in words.
//   2. Pages are written as they arrive; the whole file is never held in memory, so a clip of gigabytes takes one page of memory.
//   3. The file is written 0600 in a folder only this run makes, and the folder is removed in a finally, whether the program
//      or a read failed. Nothing is kept on the computer after the run.
//   4. The person's file is read, never changed.
//
//   withFilesIdentityAsFile(host, identity, use, { mostBytes, readBytes }) -> whatever use(path) answers
import { mkdtemp, open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMITS = JSON.parse(readFileSync(fileURLToPath(new URL('./files-identity-as-a-file.json', import.meta.url)), 'utf8'));

/**
 * Writes the file named by `identity` into a private folder as `source.mp4`, calls `use(path)`, and removes the folder.
 * `host` is the run's host (read-data/host-actions.mjs): its `files(method, input)` reads each page.
 */
export async function withFilesIdentityAsFile(host, identity, use, { mostBytes = LIMITS.most_bytes, readBytes = LIMITS.read_bytes } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'footage-'));
  try {
    const file = path.join(folder, LIMITS.file_name);
    const handle = await open(file, 'wx', 0o600);
    try {
      let offset = 0;
      for (;;) {
        const piece = await host.files('read_file', { name_or_identity: identity, offset, length: readBytes });
        if (piece.byte_length > mostBytes) {
          throw Object.assign(new Error(`${identity} is ${piece.byte_length} bytes; the most this tool reads is ${mostBytes}.`), { code: 'file_too_large' });
        }
        await handle.write(Buffer.from(piece.content ?? '', piece.encoding === 'base64' ? 'base64' : 'utf8'));
        offset += piece.bytes_returned;
        if (!piece.bytes_returned || offset >= piece.byte_length) break;
      }
    } finally {
      await handle.close();
    }
    return await use(file);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
