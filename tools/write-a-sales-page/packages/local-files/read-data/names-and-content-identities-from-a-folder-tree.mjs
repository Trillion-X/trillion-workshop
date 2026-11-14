// packages/local-files/read-data/names-and-content-identities-from-a-folder-tree.mjs
//
// A table of names and content identities from a folder tree, yielded one row at a time.
//
// PURPOSE. Something has to turn "these bytes exist under this root" into rows a namespace can
// address. `live-namespace`'s `publishNamespaceRecords` already takes `openRows` as ANY async
// generator and turns `{ name, sha256Hex, storedPath }` into locator and name records, proven at
// 75,869 locators. What was missing was a producer of those rows for a tree nobody has already
// tabulated. This is that producer and nothing more.
//
// NAMED FOR THE CAPABILITY, NOT ITS FIRST CALLER. The occasion was a camera card, and a camera is
// the one thing this file must not know about. A card, an external drive, a phone's export folder
// and an ordinary directory are the same job, so the name says folder tree.
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. The hash is STREAMED. `ask-local-file-content-digest.mjs` computes the same digest with
//      `readFileSync`, which is correct for the small artifacts it was written for and fatal here:
//      the measured corpus this feeds includes single files of 54 GB, and one of them would take
//      the process down before the first row was yielded. Streaming is the reason this is a
//      separate reader rather than a loop around the existing one.
//
//   2. An unreadable directory SKIPS, it does not abort. A camera card carries `.Trashes` that
//      answers permission-denied; a walk that throws there loses every row after it, which reads
//      as "the card had 40 files" rather than as an error. The skipped path is reported so the
//      caller can decide, and losing the walk is never the quiet default.
//
//   3. The order is STABLE. Entries are sorted at every level, so a walk interrupted at row N and
//      resumed through the publisher's `startRow` lands on the same row. An unsorted readdir makes
//      resumption silently address different bytes.
//
//   4. What to SKIP is the caller's, not this file's. A hardcoded list of noise names
//      (`.DS_Store`, `.Trashes`, thumbnails) would be an enumeration of one filesystem's habits,
//      and the next source spells its noise differently. The caller passes a predicate.
//
//   5. A symlink is NOT followed. Following one turns a tree walk into a graph walk with cycles,
//      and it lets a link inside the tree publish bytes from outside the root under a name that
//      claims otherwise.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";

/** The content identity of one file, computed without holding the file in memory.
 *
 *  Returns the lowercase hex sha256 and the byte length, because the caller needs the length for
 *  the locator's `byte_length` and reading the file twice to get it would double a 14 TB walk. */
export async function contentIdentityOfOneFile(absolutePath, { openStream = createReadStream } = {}) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of openStream(absolutePath)) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return { sha256Hex: hash.digest("hex"), byteLength };
}

/** Relative path from the root, in POSIX spelling, which is what a name address is built from. */
function nameFrom(rootAbsolutePath, absolutePath) {
  return path.relative(rootAbsolutePath, absolutePath).split(path.sep).join("/");
}

/**
 * Yield `{ name, sha256Hex, storedPath, byteLength }` for every readable file under a root.
 *
 * `name` is the path relative to the root, which is the identity a human uses; `storedPath` is the
 * absolute path the bytes are at right now. They are different facts on purpose: the name outlives
 * the volume being mounted at this exact place, and the locator's request needs the absolute one.
 *
 * @param {string} rootAbsolutePath
 * @param {object} [options]
 * @param {(entry:{name:string,relativePath:string,isDirectory:boolean})=>boolean} [options.skipEntry]
 *        Return true to leave an entry out. Defaults to skipping nothing.
 * @param {(report:{relativePath:string,reason:string})=>void} [options.onUnreadable]
 *        Called for a directory or file that could not be read. Defaults to ignoring, because the
 *        walk continuing is the invariant; a caller that needs to know says so.
 */
export async function* namesAndContentIdentitiesFromAFolderTree(rootAbsolutePath, {
  skipEntry = () => false,
  onUnreadable = () => {},
  openDirectory = opendir,
  statPath = stat,
  identityOf = contentIdentityOfOneFile,
} = {}) {
  // Explicit stack rather than recursion: a deep tree must not be bounded by the call stack, and
  // the walk order stays visible in one place.
  const pending = [rootAbsolutePath];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      const handle = await openDirectory(directory);
      entries = [];
      for await (const entry of handle) entries.push(entry);
    } catch (error) {
      onUnreadable({ relativePath: nameFrom(rootAbsolutePath, directory), reason: String(error?.code ?? error) });
      continue;
    }

    // Sorted so a resumed walk addresses the same row. Directories are pushed in reverse so the
    // stack pops them in sorted order too.
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const directoriesHere = [];
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = nameFrom(rootAbsolutePath, absolutePath);
      // A symlink is neither followed nor hashed: see invariant 5.
      if (entry.isSymbolicLink()) continue;
      const isDirectory = entry.isDirectory();
      if (skipEntry({ name: entry.name, relativePath, isDirectory })) continue;
      if (isDirectory) { directoriesHere.push(absolutePath); continue; }
      if (!entry.isFile()) continue;

      try {
        const { sha256Hex, byteLength } = await identityOf(absolutePath);
        // Asked of the file itself rather than trusted from the dirent, because a file still being
        // written by a camera would otherwise publish a length that disagrees with its own bytes.
        const measured = await statPath(absolutePath);
        yield {
          name: relativePath,
          sha256Hex,
          storedPath: absolutePath,
          byteLength: measured.size ?? byteLength,
        };
      } catch (error) {
        onUnreadable({ relativePath, reason: String(error?.code ?? error) });
      }
    }

    for (let index = directoriesHere.length - 1; index >= 0; index -= 1) pending.push(directoriesHere[index]);
  }
}
