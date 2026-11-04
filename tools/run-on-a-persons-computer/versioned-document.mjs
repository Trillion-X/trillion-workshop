// computer/versioned-document.mjs
//
// PURPOSE
//   A small JSON document kept on this Mac (learned preferences, a profile) that carries its schema version, is backed up before
//   any migration changes it, and tags every entry with the evidence that produced it, so a later reader can say why Trillion
//   believes it and a bad migration can be undone from the backup.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which keys exist and how an old version becomes the next is the caller's `migrations` ({ <from version>: fn(data) → data }); this
//      file names none.
//   2. A document newer than the code understands is refused untouched, never downgraded or rewritten.
//   3. Before a migration writes, the old file is copied to `<file>.v<from>.bak`; a migration that throws leaves the original in place.
//   4. Writes are atomic (a temporary file renamed over the document). Every entry is { value, evidence, at }; an entry without
//      evidence is refused.
//
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const refusal = (message, status = 400) => Object.assign(new Error(message), { status });

export function openDocument({ file, version, migrations = {}, now = () => Date.now() }) {
  const save = doc => { const next = `${file}.next`; writeFileSync(next, JSON.stringify(doc, null, 2), { mode: 0o600 }); renameSync(next, file); };
  const load = () => {
    if (!existsSync(file)) return { version, entries: {} };
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { throw refusal(`${file} is not readable JSON; it was left as it is.`); }
    if (!Number.isInteger(doc.version)) throw refusal(`${file} has no version; it was left as it is.`);
    if (doc.version > version) throw refusal(`${file} is version ${doc.version}, newer than this program understands (${version}); it was left as it is.`, 409);
    if (doc.version === version) return doc;
    let current = doc;
    copyFileSync(file, `${file}.v${doc.version}.bak`);
    while (current.version < version) {
      const step = migrations[current.version];
      if (typeof step !== 'function') throw refusal(`No migration from version ${current.version}; the original is kept and a backup was made.`);
      current = { ...step(structuredClone(current)), version: current.version + 1 };
    }
    save(current);
    return current;
  };
  return {
    read: () => load(),
    get: key => load().entries[key],
    /** Sets one entry; `evidence` says what produced it (a record id, a quote, an action). */
    set(key, value, evidence) {
      if (typeof evidence !== 'string' || !evidence.trim()) throw refusal(`${key} needs the evidence that produced it.`);
      const doc = load();
      doc.entries[key] = { value, evidence, at: new Date(now()).toISOString() };
      save(doc);
      return doc.entries[key];
    },
    remove(key) { const doc = load(); const had = key in doc.entries; delete doc.entries[key]; save(doc); return had; },
  };
}
