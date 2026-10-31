// tools/documents-as-list-rows/read-data/folder-files.mjs
//
// Purpose: the `files` that document-properties.mjs reads rows from and writes properties to, over one folder on the
// person's own computer. Names are paths under the folder written with a leading `/` (`/notes/plan.md`), the same
// shape a Namespace name has, so the row source reads a computer folder and a Namespace folder alike.
//
// Non-Negotiable Invariants:
//   1. Nothing outside the folder is read or written: every name is resolved to its real path and refused unless that
//      path is under the folder's real path (a link pointing out is not followed). Folders whose names start with `.`
//      are not listed.
//   2. A document's identity is `1f:` and the BLAKE3 of its exact bytes (tools/content-identity), worked out when the
//      document is read, so a listing reads no document.
//   3. A conditional write puts the new bytes in place only if the document still has the identity the caller read:
//      it reads and hashes the document again, answers { conflict, current } when it differs, and otherwise writes the
//      bytes beside it and renames them over it in one step, so a reader sees the old document or the new one.
//
//   folderFiles(root) → { foldersUnder, list, entry, read, writeIfUnchanged }
import { lstat, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** The files of one folder, by names written `/a/b.md` under it. */
export async function folderFiles(root) {
  const base = await realpath(root);
  // One current document snapshot for its bounded content pieces. Reading the metadata already reads its bytes to
  // establish BLAKE3; this cache prevents hashing a long document again for each small text piece on one page.
  let contentSnapshot = null;
  const inside = path => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
  const nameOf = path => `/${relative(base, path).split(sep).join('/')}`;
  const pathOf = async name => {
    const wanted = join(base, ...String(name).split('/').filter(Boolean));
    // A name that does not exist yet is judged by the real path of its folder.
    const real = await realpath(wanted).catch(async () => join(await realpath(dirname(wanted)).catch(() => dirname(wanted)), basename(wanted)));
    if (!inside(real)) throw Object.assign(new Error(`${name} is not in the folder.`), { code: 'not_a_document' });
    return real;
  };
  const visible = entry => !entry.name.startsWith('.');

  // What a directory entry is, from the directory read itself (no stat), following a link only when it stays inside.
  const kindOf = async (path, entry) => {
    if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : null;
    const real = await realpath(path).catch(() => null);
    if (!real || !inside(real)) return null;
    const facts = await stat(real);
    return facts.isDirectory() ? 'folder' : facts.isFile() ? 'file' : null;
  };

  return {
    async foldersUnder(folder) {
      const found = [];
      const walk = async path => {
        for (const entry of (await readdir(path, { withFileTypes: true })).filter(visible)) {
          const next = join(path, entry.name);
          if ((await kindOf(next, entry)) === 'folder') { found.push(nameOf(next)); await walk(next); }
        }
      };
      await walk(await pathOf(folder));
      return found.sort();
    },
    // The names of a folder's files, a page at a time. A listing reads names only; a document's size and times come with
    // its bytes (`read`), so listing a folder of thousands of documents costs one directory read.
    async list(folder, after, limit) {
      const path = await pathOf(folder);
      const rows = [];
      for (const entry of (await readdir(path, { withFileTypes: true })).filter(visible)) {
        const full = join(path, entry.name);
        if ((await kindOf(full, entry)) === 'file') rows.push({ name: nameOf(full) });
      }
      rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const shown = rows.filter(row => !after || row.name > after).slice(0, limit);
      return { names: shown, next_after: shown.length === limit && rows.at(-1).name !== shown.at(-1).name ? shown.at(-1).name : null };
    },
    async entry(name, { identity = true } = {}) {
      const path = await pathOf(name);
      const facts = await stat(path).catch(() => null);
      if (!facts) return null;
      if (facts.isDirectory()) return { name, folder: true };
      return { name, ...(identity ? { identity: makeHashCodeHexFromBytes(await readFile(path)) } : {}), byte_length: facts.size, modified_at_ms: facts.mtimeMs };
    },
    // The first `most` bytes of the named document as text: { identity, text, complete, facts }. `identity` is ignored
    // here (a folder's documents are read by name) and answered from the bytes read; `facts` are its size and times.
    async read(_identity, most, name) {
      const path = await pathOf(name);
      const [bytes, facts] = await Promise.all([readFile(path), stat(path)]);
      return { identity: makeHashCodeHexFromBytes(bytes), text: new TextDecoder().decode(bytes.subarray(0, most)), complete: bytes.length <= most,
        facts: { byte_length: facts.size, modified_at_ms: facts.mtimeMs, named_at: facts.birthtimeMs } };
    },
    async readSlice(expected, offset, length, name) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw Object.assign(new Error('A document byte range is non-negative whole numbers.'), { code: 'bad_input' });
      if (contentSnapshot?.name !== name || contentSnapshot.identity !== expected) {
        const bytes = await readFile(await pathOf(name));
        contentSnapshot = { name, bytes, identity: makeHashCodeHexFromBytes(bytes) };
      }
      return { identity: contentSnapshot.identity, bytes: contentSnapshot.bytes.subarray(offset, offset + length) };
    },
    async writeIfUnchanged(name, text, expected) {
      const path = await pathOf(name);
      const now = await readFile(path).catch(() => null);
      const current = now ? makeHashCodeHexFromBytes(now) : null;
      if (current !== expected) return { conflict: true, current };
      if (now && (await lstat(path)).isSymbolicLink()) throw Object.assign(new Error(`${name} is a link; change the document it points to.`), { code: 'not_a_document' });
      const bytes = new TextEncoder().encode(text);
      // The new bytes are written and synced in an empty folder beside the document, then renamed over it; the folder,
      // empty again, is removed.
      const scratch = await mkdtemp(join(dirname(path), '.writing-'));
      const staged = join(scratch, 'document');
      await writeFile(staged, bytes);
      const handle = await open(staged, 'r+');
      await handle.sync();
      await handle.close();
      await rename(staged, path);
      await rmdir(scratch);
      return { identity: makeHashCodeHexFromBytes(bytes) };
    },
  };
}
