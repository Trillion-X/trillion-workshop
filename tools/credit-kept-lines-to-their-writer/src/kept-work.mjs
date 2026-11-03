// src/kept-work.mjs
//
// PURPOSE
//   Tells what each actor wrote from what stayed. Given the versions of a text (oldest first) and who wrote each, it
//   credits every line to whoever first wrote it, by the line's BLAKE3 identity, and reports how many of the lines in
//   the newest version are each actor's. That is the share of kept work, not of generated work: a line written and later
//   edited away is not counted, and a line a person rewrote is the person's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. keptWork is pure: the versions are given (versionsFromLog turns record-change log rows into them). The ledger
//      (makeKeptWork) is the only thing here that keeps anything: for each tracked record field one row per line still in the
//      newest text, holding the line's BLAKE3 identity and its first writer, never the line itself; written() runs inside the
//      write's own transaction (src/person-store.mjs, through src/decision-store.mjs), so attribution is recorded on the real
//      write and the change log's short life does not lose it.
//   2. A line's identity is the BLAKE3 of its normalized text (src/kept-work.json); the same line written by two actors is
//      credited to the first, and one that disappears and comes back is credited to whoever wrote it back.
//   3. Every name and rule is DATA (src/kept-work.json): this file names no actor kind and no field.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './kept-work.json' with { type: 'json' };

const identityOf = (line, rules) => bytesToHex(blake3(new TextEncoder().encode(line))).slice(0, rules.identity_chars);
const normalized = (line, rules) => {
  let text = line;
  if (rules.normalize.trim) text = text.trim();
  if (rules.normalize.collapse_spaces) text = text.replace(/\s+/g, ' ');
  if (rules.normalize.lowercase) text = text.toLowerCase();
  return text;
};
const linesOf = (text, rules) => String(text ?? '').split('\n').map(line => normalized(line, rules)).filter(line => line || rules.blank_lines !== 'ignored');

/** { by: { actor: lines kept }, kept: lines in the newest version, versions } for versions [{ by, text }], oldest first. */
export function keptWork(versions, rules = settings) {
  const credit = new Map();
  let present = new Set();
  for (const version of versions) {
    const now = new Set(linesOf(version.text, rules).map(line => identityOf(line, rules)));
    for (const identity of now) if (!present.has(identity)) credit.set(identity, version.by ?? rules.nobody);
    present = now;
  }
  const by = {};
  for (const identity of present) by[credit.get(identity)] = (by[credit.get(identity)] ?? 0) + 1;
  return { by, kept: present.size, versions: versions.length };
}

/** Versions from the log rows of one text field (eeaf log of its attribute_fact address: { patch, actor_context }): `textOf(value)` picks the text from a change's value, the value itself when it is text. */
export function versionsFromLog(rows, textOf = value => (typeof value === 'string' ? value : undefined), rules = settings) {
  return rows.flatMap(row => {
    let patch, actor;
    try { patch = JSON.parse(row.patch); actor = JSON.parse(row.actor_context || '{}'); } catch { return []; }
    const text = patch?.op === 'delete' ? '' : textOf(patch?.value);
    return typeof text === 'string' ? [{ by: actor?.[rules.credit_by] ?? rules.nobody, text }] : [];
  });
}

/**
 * The ledger over a store's SQLite: `written(records, context)` is told of every write ([{ id, type, value }], context.actor)
 * and credits the lines of each tracked field to the actor of the write that first put them there; `read` answers
 * { by, kept } for one record field from the rows. A line that left and came back is credited to whoever wrote it back.
 */
export function makeKeptWork({ sql, rules = settings }) {
  sql.exec('CREATE TABLE IF NOT EXISTS kept_work_lines (record_id TEXT NOT NULL, field TEXT NOT NULL, identity TEXT NOT NULL, by TEXT NOT NULL, PRIMARY KEY (record_id, field, identity))');
  const { type_prefixes: prefixes, fields, max_lines: most } = rules.track;
  const rowsOf = (record_id, field) => sql.exec('SELECT identity, by FROM kept_work_lines WHERE record_id = ? AND field = ? LIMIT ?', record_id, field, most + 1).toArray();
  return {
    written(records, context) {
      const by = context?.actor?.[rules.credit_by] ?? rules.nobody;
      for (const record of records) {
        if (!prefixes.some(prefix => String(record.type ?? '').startsWith(prefix))) continue;
        for (const field of fields) {
          const text = record.value?.[field];
          if (typeof text !== 'string') continue;
          const now = new Set(linesOf(text, rules).slice(0, most).map(line => identityOf(line, rules)));
          const kept = new Set(rowsOf(record.id, field).map(row => row.identity));
          for (const identity of kept) if (!now.has(identity)) sql.exec('DELETE FROM kept_work_lines WHERE record_id = ? AND field = ? AND identity = ?', record.id, field, identity);
          for (const identity of now) if (!kept.has(identity)) sql.exec('INSERT INTO kept_work_lines (record_id, field, identity, by) VALUES (?, ?, ?, ?)', record.id, field, identity, by);
        }
      }
    },
    /** { by: { actor: lines kept }, kept } for one record field, from the rows; kept is 0 for a field never attributed. */
    read({ record_id, field }) {
      const by = {};
      const rows = rowsOf(record_id, field).slice(0, most);
      for (const row of rows) by[row.by] = (by[row.by] ?? 0) + 1;
      return { by, kept: rows.length };
    },
    /** Lets go of everything kept for one record (its erasure). */
    erase(record_id) { sql.exec('DELETE FROM kept_work_lines WHERE record_id = ?', record_id); },
  };
}
