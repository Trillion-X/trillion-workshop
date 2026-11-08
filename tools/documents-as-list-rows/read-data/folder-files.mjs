// tools/documents-as-list-rows/read-data/folder-files.mjs
//
// Purpose: the `files` that document-properties.mjs reads rows from and writes properties to, over one folder on the
// person's own computer. Names are paths under the folder written with a leading `/` (`/notes/plan.md`), the same
// shape a Namespace name has, so the row source reads a computer folder and a Namespace folder alike.
//
// Non-Negotiable Invariants:
//   1. Under externally serialized cooperating writers and stable directory bindings, names resolve to their real paths and are refused
//      unless under the folder's real path. These path checks are not an OS directory capability against arbitrary
//      concurrent parent replacement; strict atomic/confined publication is unsupported and refused. Folders whose
//      names start with `.` are not listed.
//   2. A document's identity is `1f:` and the BLAKE3 of its exact bytes (tools/content-identity), worked out when the
//      document is read, so a listing reads no document.
//   3. The ordinary-folder adapter requires externally serialized writers: it compares the read identity, then publishes
//      with rename (or removes with unlink). POSIX does not make that comparison atomic with publication, and path
//      checks cannot confine an arbitrary concurrent symlink replacement. A caller requiring atomic, confined
//      publication is refused BEFORE directory creation, staging, writing or removal; there is no silent downgrade.
//      Stable-path checks resolve the nearest existing ancestor before creating missing directories, never a lexical
//      fallback through an unresolved link. This is not a claim of arbitrary-writer filesystem CAS.
//
//   folderFiles(root) → { foldersUnder, list, entry, read, writeIfUnchanged, removeIfUnchanged }
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
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
  const absentOnly = error => { if (error.code === 'ENOENT') return null; throw error; };
  const pathOf = async name => {
    const wanted = join(base, ...String(name).split('/').filter(Boolean));
    if (!inside(wanted)) throw Object.assign(new Error(`${name} is not in the folder.`), { code: 'not_a_document' });
    // Resolve the nearest existing ancestor. A missing immediate parent is not evidence that its lexical path is
    // confined: an earlier component can already be a link outside the root, including a dangling link.
    let ancestor = wanted;
    const missing = [];
    let real;
    for (;;) {
      try { real = join(await realpath(ancestor), ...missing.reverse()); break; }
      catch (error) {
        const existing = error.code === 'ENOENT' ? await lstat(ancestor).catch(failure => {
          if (failure.code === 'ENOENT') return null;
          throw failure;
        }) : true;
        if (existing) {
          throw Object.assign(new Error(`${name} has no qualified path in the folder.`), { code: 'not_a_document' });
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw Object.assign(new Error(`${name} has no existing ancestor.`), { code: 'not_a_document' });
        missing.push(basename(ancestor));
        ancestor = parent;
      }
    }
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
    capabilities: { atomic_confined_publication: false, concurrency: 'external_serialization_required' },
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
      const facts = await stat(path).catch(absentOnly);
      if (!facts) return null;
      if (facts.isDirectory()) return { name, folder: true };
      if (!facts.isFile()) throw Object.assign(new Error(`${name} is not a regular document file.`), { code: 'not_a_document' });
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
    async writeIfUnchanged(name, text, expected, _mediaType, { require_atomic = false } = {}) {
      if (require_atomic) throw Object.assign(new Error('This ordinary folder has no atomic confined publication owner.'), { code: 'not_written' });
      if (_mediaType !== undefined && typeof _mediaType !== 'string') throw Object.assign(new Error('Publication options belong in the options argument.'), { code: 'bad_input' });
      const path = await pathOf(name);
      const facts = await lstat(path).catch(absentOnly);
      if (facts && !facts.isFile()) throw Object.assign(new Error(`${name} is not a regular document file.`), { code: 'not_a_document' });
      const now = await readFile(path).catch(absentOnly);
      const current = now ? makeHashCodeHexFromBytes(now) : null;
      if (current !== expected) return { conflict: true, current };
      if (now && (await lstat(path)).isSymbolicLink()) throw Object.assign(new Error(`${name} is a link; change the document it points to.`), { code: 'not_a_document' });
      if (!now) await mkdir(dirname(path), { recursive: true });
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
    async removeIfUnchanged(name, expected, { require_atomic = false } = {}) {
      if (require_atomic) throw Object.assign(new Error('This ordinary folder has no atomic confined publication owner.'), { code: 'not_written' });
      const path = await pathOf(name);
      const now = await readFile(path).catch(absentOnly);
      const current = now ? makeHashCodeHexFromBytes(now) : null;
      if (!now || current !== expected) return { conflict: true, current };
      if ((await lstat(path)).isSymbolicLink()) throw Object.assign(new Error(`${name} is a link; remove the document it points to.`), { code: 'not_a_document' });
      await unlink(path);
      return { removed: true };
    },
  };
}
