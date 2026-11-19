// tools/documents-as-list-rows/read-data/namespace-files.mjs
//
// Purpose: the `files` document-properties.mjs reads rows from, over the person's Namespace files that the caller hands
// in as `stored.files` ({ "/Notes/plan.md": text, "/Notes/scan.bin": { base64 } }). The caller reads them from the
// Namespace with its own reach; this module only shapes them, into the same shape folder-files.mjs gives a folder on
// the person's computer.
//
// Non-Negotiable Invariants:
//   1. Only the names handed in exist: a listing and a read answer from them, and a name not handed in is not found.
//   2. A document's identity is `1f:` and the BLAKE3 of its exact bytes (tools/content-identity), the same as a folder's.
//   3. Nothing is written or removed here: a handed-in set has no conditional write, so `writeIfUnchanged` and
//      `removeIfUnchanged` refuse, and a document is never changed without knowing it is still the one read.
//
//   namespaceFiles(files) → { foldersUnder, list, entry, read, readSlice, writeIfUnchanged, removeIfUnchanged }, where
//   files is the handed-in map of names to text or { base64 }.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const say = (code, words) => Object.assign(new Error(words), { code });
const folderOf = name => (name.endsWith('/') ? name : `${name}/`);

// One name's exact bytes: text as utf-8, or the bytes its { base64 } names. Anything else is refused, never guessed.
function bytesOf(name, content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content !== null && typeof content === 'object' && !Array.isArray(content) && typeof content.base64 === 'string') {
    return Buffer.from(content.base64, 'base64');
  }
  throw say('bad_input', `${name} must be handed in as text or as {base64}.`);
}

export function namespaceFiles(handed) {
  if (handed === null || typeof handed !== 'object' || Array.isArray(handed)) {
    throw say('bad_input', 'The Namespace files must be handed in as stored.files: {name: text or {base64}}.');
  }
  const files = new Map(Object.entries(handed).map(([name, content]) => {
    if (!name.startsWith('/')) throw say('bad_input', `${name} is not a Namespace name: it starts with /.`);
    const bytes = bytesOf(name, content);
    return [name, { bytes, identity: makeHashCodeHexFromBytes(bytes) }];
  }));
  const named = name => {
    const file = files.get(name);
    if (!file) throw say('not_a_document', `${name} was not handed in.`);
    return file;
  };
  // The names directly under `folder`, sorted.
  const childrenOf = folder => {
    const prefix = folderOf(folder);
    return [...files.keys()].filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).sort();
  };
  return {
    // Every folder under `folder`, from the folders the handed-in names pass through.
    async foldersUnder(folder) {
      const found = new Set();
      const base = folderOf(folder);
      for (const name of files.keys()) {
        if (!name.startsWith(base)) continue;
        let at = folder.replace(/\/$/, '');
        for (const part of name.slice(base.length).split('/').slice(0, -1)) {
          at = `${at}/${part}`;
          found.add(at);
        }
      }
      return [...found].sort();
    },
    // The names of a folder's files, a page at a time. A listing reads names only.
    async list(folder, after, limit) {
      const rest = childrenOf(folder).filter(name => !after || name > after);
      const shown = rest.slice(0, limit);
      return { names: shown.map(name => ({ name })), next_after: rest.length > shown.length ? shown.at(-1) : null };
    },
    async entry(name, { identity = true } = {}) {
      const file = files.get(name);
      if (!file) return null;
      return { name, ...(identity ? { identity: file.identity } : {}), byte_length: file.bytes.length };
    },
    // The first `most` bytes of the named document as text: { identity, text, complete, facts }.
    async read(_identity, most, name) {
      const file = named(name);
      return { identity: file.identity, text: new TextDecoder().decode(file.bytes.subarray(0, most)), complete: file.bytes.length <= most,
        facts: { byte_length: file.bytes.length } };
    },
    async readSlice(expected, offset, length, name) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw say('bad_input', 'A document byte range is non-negative whole numbers.');
      const file = named(name);
      if (file.identity !== expected) throw say('document_changed', `${name} changed while its content was read.`);
      return { identity: file.identity, bytes: file.bytes.subarray(offset, offset + length) };
    },
    async writeIfUnchanged(name) {
      throw say('not_written', `${name} is a handed-in Namespace file: nothing here writes it, and no write checks the file is still the one read.`);
    },
    async removeIfUnchanged(name) {
      throw say('not_written', `${name} is a handed-in Namespace file: nothing here removes it, and no removal checks the file is still the one read.`);
    },
  };
}
