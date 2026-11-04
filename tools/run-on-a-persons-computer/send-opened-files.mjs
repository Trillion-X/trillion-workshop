// computer/send-opened-files.mjs
//
// Purpose
//   Keeps files the person opened with Trillion on this Mac (Finder's Open With > Trillion, a file dropped on the Dock
//   icon) in their Trillion files, when a file is too big to go into the message box (macos/App/MenuBarPanel.swift
//   hand, menu-bar-panel.json `opened`). Each goes through the shared chunked sender
//   (parts/live-namespace/do-work/send-a-file-to-a-namespace.mjs) under `<folder>/<its name>`, so it can be opened
//   while it is still going up and nothing the service already holds is sent again.
//
//     node computer/send-opened-files.mjs --folder "/Opened on this Mac" <file> [file...]   (account key on stdin)
//     node computer/send-opened-files.mjs --folder "/Opened on this Mac" --files-from-stdin
//       (account key on the first stdin line, then the complete ordered native files packet)
//
//   Prints one JSON line when done: { kept: [{ name, identity, state }], refused: [{ file, why }] }.
//
// Non-negotiable invariants
//   1. The account key is read from standard input and kept only in this process's memory; it is sent only in the
//      Authorization header.
//   2. The folder is DATA from the caller (menu-bar-panel.json `opened.folder`); this file names none.
//   3. A file the service refuses is reported, never retried here; the others are still sent.
//   4. Duplicate basenames within one opening receive numbered names.
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { fileSource, sendFile } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { mediaTypeOf } from '../browse-and-upload-my-files/do-work/send-a-folder-to-a-namespace.mjs';
import { fileType } from './file-type.mjs';

/** The key is the first stdin line; the app's ordered files packet follows as JSON, never in process arguments. */
export function openedInput(input, paths) {
  const newline = input.indexOf('\n');
  const key = (newline < 0 ? input : input.slice(0, newline)).trim();
  const rest = newline < 0 ? '' : input.slice(newline + 1).trim();
  if (!key) throw new Error('Sign in to Trillion to open these files.');
  if (!rest) {
    if (paths === null) throw new Error('The files to open could not be checked.');
    return { key, files: paths };
  }
  const supplied = JSON.parse(rest)?.files;
  // The signed app already carries the paths on stdin. Duplicating that vector in argv hits
  // macOS ARG_MAX before the helper can start. An explicit native mode keeps the complete ordered packet.
  // The positional CLI continues to require an exact path/order match.
  if (!Array.isArray(supplied) || (paths === null
    ? !supplied.length || supplied.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.file !== 'string' || !path.isAbsolute(row.file) || row.file.includes('\0'))
    : supplied.length !== paths.length || supplied.some((row, index) => row?.file !== paths[index])))
    throw new Error('The files to open could not be checked.');
  return { key, files: supplied };
}

const nextName = (folder, basename, copy) => {
  const extension = path.extname(basename), stem = basename.slice(0, basename.length - extension.length);
  return `${folder.replace(/\/$/, '')}/${copy === 1 ? basename : `${stem} (${copy})${extension}`}`;
};

/** Each file goes through the existing chunked sender under its own name in `folder`. */
export async function sendOpenedFiles({ client, chunking, folder, files, mediaType = mediaTypeOf, send = sendFile, open = fileSource }) {
  const kept = [], refused = [];
  const reserved = new Set();
  for (const handed of files) {
    const file = typeof handed === 'string' ? handed : handed?.file;
    const basename = path.basename(file ?? '');
    let source;
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('The file to open could not be checked.');
      let copy = 1, name = nextName(folder, basename, copy);
      while (reserved.has(name)) name = nextName(folder, basename, ++copy);
      reserved.add(name);
      source = await open(file);
      const answer = await send({ client, source, chunking: typeof chunking === 'function' ? await chunking() : chunking, name, mediaType: fileType(await mediaType(file), [file]) });
      kept.push({ name, identity: answer.identity ?? null, state: answer.state ?? null });
    } catch (error) {
      refused.push({ file: basename, why: error instanceof Error ? error.message : String(error) });
    } finally {
      // Cleanup is per-file and must never overwrite an accepted send or prevent the next source from being opened.
      if (source) try { await source.close(); } catch {}
    }
  }
  return { kept, refused };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const at = arguments_.indexOf('--folder');
  const folder = at >= 0 ? arguments_[at + 1] : '';
  const fromStdin = arguments_.includes('--files-from-stdin');
  const files = arguments_.filter((value, index) => index !== at && index !== at + 1 && value !== '--files-from-stdin');
  if (!folder || (fromStdin ? files.length || arguments_.filter(value => value === '--files-from-stdin').length !== 1 : !files.length)) {
    process.stderr.write('send-opened-files: name --folder and files, or --files-from-stdin\n'); process.exit(2);
  }
  const rows = JSON.parse(readFileSync(new URL('./computer-sources.json', import.meta.url), 'utf8'));
  const origin = process.env.TRILLION_ORIGIN ?? rows.origin;
  let key = '';
  for await (const chunk of process.stdin) key += chunk;
  const input = openedInput(key, fromStdin ? null : files);
  key = input.key;
  const control = bearerControl({ origin, authorization: async () => `Bearer ${key}` });
  const answer = await sendOpenedFiles({ client: namespaceClient({ origin, control }), chunking: loadChunking, folder, files: input.files });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  if (answer.refused.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
