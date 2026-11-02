// tools/read-a-list-view/read-data/joined-copy.mjs
//
// Purpose: one file that is many rows' text joined in order, written from the rows and never by hand. A person's
// instructions are rows (each a paragraph any of their AIs reads through the door); an app that reads only a file at
// start (a coding harness's AGENTS.md or CLAUDE.md) gets that file made from the same rows. One direction only: the
// rows are the original, the file is their copy, and a guard of the person's refuses hand edits to it.
//
// Non-Negotiable Invariants:
//   1. No row, record type, prefix, field or file is named here: the spec names them all.
//   2. The file is written only while it is still the one read (the documents source's change tool checks its
//      identity), so a write made meanwhile is never overwritten; the next run makes it again from the rows.
//   3. A copy bigger than the spec's `most_bytes` is refused and nothing is written: an app that loads the file at
//      start has a budget, and the rows are what must shrink.
//   4. Rows are read in bounded pages through the door's records list, each prefix to its end.
//
//   writeJoinedCopy({ root, name, type, prefixes, text_at, order_at, header?, most_bytes, dry_run? }, door)
//     → { name, rows, bytes, written, identity }
//     door: { list({ type, prefix, limit, after? }) → { records, next }, run(tool, input) → { result } }
//     The documents tools (tool:read-documents-as-list-rows, tool:change-a-document-row) read and write the file.
import data from './list-view.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const say = (code, words) => Object.assign(new Error(words), { code });
const at = (value, path) => path.split('.').reduce((held, part) => (held == null ? held : held[part]), value);
const READ = 'tool:read-documents-as-list-rows';
const CHANGE = data.row_sources.documents.change.tool;

function checked(spec) {
  const { root, name, type, prefixes, text_at: textAt, order_at: orderAt, most_bytes: mostBytes } = spec ?? {};
  if (typeof root !== 'string' || !root.startsWith('/')) throw say('bad_input', 'root is the absolute folder the copy is in.');
  if (typeof name !== 'string' || !name.startsWith('/') || name.includes('..')) throw say('bad_input', 'name is the copy\'s path under root, starting with /.');
  if (typeof type !== 'string' || !type) throw say('bad_input', 'type is the record type of the rows.');
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some(prefix => typeof prefix !== 'string' || !prefix)) {
    throw say('bad_input', 'prefixes names the id starts of the rows the copy is made of.');
  }
  if (typeof textAt !== 'string' || !textAt || typeof orderAt !== 'string' || !orderAt) throw say('bad_input', 'text_at and order_at name where a row keeps its text and order.');
  if (!Number.isSafeInteger(mostBytes) || mostBytes < 1) throw say('bad_input', 'most_bytes is the most bytes the copy may hold.');
  return spec;
}

/** Every record of `type` whose id starts with `prefix`, page after page. */
async function recordsOf(door, type, prefix) {
  const found = [];
  const seen = new Set();
  for (let after = null; ;) {
    const page = await door.list({ type, prefix, limit: data.limits.door_page_rows, ...(after ? { after } : {}) });
    if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${prefix} answered no records.`);
    found.push(...page.records);
    if (!page.next || !page.records.length) return found;
    if (seen.has(page.next)) throw say('source_cursor_stalled', `Listing ${prefix} did not advance its cursor.`);
    seen.add(page.next);
    after = page.next;
  }
}

/** The copy's text: the header, then each row's text in order (then id), a blank line between. */
export function joinedText(records, spec) {
  const rows = records
    .map(record => ({ id: record.id, text: at(record.value, spec.text_at), order: Number(at(record.value, spec.order_at) ?? Number.MAX_SAFE_INTEGER) }))
    .filter(row => typeof row.text === 'string' && row.text.trim());
  rows.sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts = [...(spec.header ? [spec.header.trimEnd()] : []), ...rows.map(row => row.text.trim())];
  return { rows: rows.length, text: `${parts.join('\n\n')}\n` };
}

export async function writeJoinedCopy(spec, door) {
  const { root, name, type, prefixes, most_bytes: mostBytes, dry_run: dryRun = false } = checked(spec);
  const records = [];
  for (const prefix of prefixes) records.push(...await recordsOf(door, type, prefix));
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  const { rows, text } = joinedText(unique, spec);
  const bytes = Buffer.byteLength(text);
  if (!rows) throw say('no_rows', `No row of ${type} starts with ${prefixes.join(' or ')}: the copy is not written from nothing.`);
  if (bytes > mostBytes) throw say('copy_too_big', `${name} would hold ${bytes} bytes, more than its ${mostBytes}: shorten the rows.`);
  const read = (await door.run(READ, { root, folder: '/', paths: [name], content: false, limit: 1 }))?.result?.rows ?? [];
  const current = read.find(row => row.id === name);
  const identity = current ? current.identity ?? current.values?.['file.identity'] ?? null : null;
  const wanted = makeHashCodeHexFromBytes(new TextEncoder().encode(text));
  if (identity === wanted || dryRun) return { name, rows, bytes, written: false, identity: dryRun ? identity : wanted };
  await door.run(CHANGE, { root, folder: '/', rows: [{ id: name, text, if_identity: identity }] });
  return { name, rows, bytes, written: true, identity: wanted };
}
