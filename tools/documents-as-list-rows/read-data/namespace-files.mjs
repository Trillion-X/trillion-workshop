// tools/documents-as-list-rows/read-data/namespace-files.mjs
//
// Purpose: the `files` document-properties.mjs reads rows from, over the person's Namespace files: the files door's
// operations (list_files, read_file) reached through the run's records door (`door.files`, tools/records-door), the
// same shape folder-files.mjs gives for a folder on the person's computer. Ported from the Namespace files of the
// lists' documents row source in the earlier Trillion app (namespaceFiles in its src/document-properties.mjs), onto
// the door's files contract.
//
// Non-Negotiable Invariants:
//   1. Every file is read by its name, so a run whose right covers one folder reads only that folder (a right's id
//      rule reaches names under its folder; an identity is under no folder).
//   2. A listing reads names only; a document's bytes come with `read`, page after page of the door's read_file until
//      the document or the bytes asked for are read.
//   3. A Namespace name has no conditional write in the files door yet, so `writeIfUnchanged` refuses: a property
//      change is never written without knowing the document is still the one read.
//
//   namespaceFiles(files) → { foldersUnder, list, entry, read, writeIfUnchanged }, where files(operation, input) is the
//   run's door.files.
const READ_BYTES = 262144;
const say = (code, words) => Object.assign(new Error(words), { code });
const folderOf = name => (name.endsWith('/') ? name : `${name}/`);
// One page's bytes: the door answers text as utf-8 and other bytes (or a page cut inside a character) as base64.
const bytesOf = page => Buffer.from(page.content ?? '', page.encoding === 'base64' ? 'base64' : 'utf8');

export function namespaceFiles(files) {
  const list = async (folder, after, limit) => {
    const page = await files('list_files', { folder: folderOf(folder), ...(after ? { after } : {}), ...(limit ? { limit } : {}) });
    return { names: page.names ?? [], next_after: page.next_after ?? null, folders: page.folders ?? [] };
  };
  return {
    // Every folder under `folder`, from the folders each first page of a listing names.
    async foldersUnder(folder) {
      const found = [];
      const walk = async at => {
        for (const child of (await list(at, null, 1)).folders) {
          const name = typeof child === 'string' ? child : child.name;
          found.push(name.replace(/\/$/, ''));
          await walk(name);
        }
      };
      await walk(folder);
      return found.sort();
    },
    list,
    async entry(name) {
      const page = await files('read_file', { name_or_identity: name, offset: 0, length: 0 }).catch(() => null);
      return page ? { name, identity: page.identity, byte_length: page.byte_length } : null;
    },
    // The first `most` bytes of the named document as text: { identity, text, complete, facts }.
    async read(_identity, most, name) {
      const parts = [];
      let offset = 0, total = null, identity = null;
      while (offset < most) {
        const page = await files('read_file', { name_or_identity: name, offset, length: Math.min(READ_BYTES, most - offset) });
        ({ identity, byte_length: total } = page);
        if (!page.bytes_returned) break;
        parts.push(bytesOf(page));
        offset += page.bytes_returned;
        if (offset >= total) break;
      }
      // The pages are joined as bytes before they are read as text, so a character cut between two pages stays whole.
      return { identity, text: Buffer.concat(parts).toString('utf8'), complete: total !== null && offset >= total, facts: { byte_length: total } };
    },
    async readSlice(expected, offset, length, name) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw say('bad_input', 'A document byte range is non-negative whole numbers.');
      const parts = [];
      let received = 0, identity = expected;
      while (received < length) {
        const page = await files('read_file', { name_or_identity: name, offset: offset + received, length: Math.min(READ_BYTES, length - received) });
        identity = page.identity;
        if (identity !== expected) throw say('document_changed', `${name} changed while its content was read.`);
        const part = bytesOf(page);
        if (!page.bytes_returned || part.length !== page.bytes_returned || part.length > length - received) throw say('bad_input', `${name} did not answer its requested byte range.`);
        parts.push(part); received += part.length;
      }
      return { identity, bytes: Buffer.concat(parts) };
    },
    async writeIfUnchanged(name) {
      throw say('not_written', `${name} is a Namespace file, and the files door has no write that checks the file is still the one read.`);
    },
  };
}
