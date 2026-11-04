// A document broken into its smallest self-contained pieces (atoms), so every check can name the exact piece it
// came from and a change to one piece is seen as that piece changing.
//
// An atom is one paragraph, one list item, one table row or one fenced block, under the headings above it. Its key
// is the heading path plus the piece's lead (its bold opening, or its first words), so an edit inside a piece keeps
// its key and changes its identity, while a new piece arrives with a new key. Titles, horizontal rules and table
// headers are not atoms.
//
// Ported from the earlier Trillion app (scripts/method-atoms.mjs there). Two changes, nothing else:
//   1. The identity hash is read from the one owner (tools/content-identity), not imported again.
//   2. Each atom also carries `line`, the 1-based line of the document where it starts, so a row can name its source.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const LEAD_WORDS = 8;
const identity = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text.replace(/\s+/g, ' ').trim()));
const plain = text => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

function lead(text) {
  const bold = text.match(/^\s*(?:[-*]|\d+\.)?\s*\*\*(.+?)\*\*/);
  if (bold) return plain(bold[1]).replace(/[.:]$/, '');
  const cells = text.match(/^\s*\|(.+?)\|/);
  if (cells) return plain(cells[1]);
  return plain(text.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')).split(' ').slice(0, LEAD_WORDS).join(' ');
}

export function atomsOf(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  const atoms = [];
  let block = [];
  let blockLine = 0;
  let fence = false;
  let firstHeading = true;
  const push = (line, index) => { if (!block.length) blockLine = index + 1; block.push(line); };
  const flush = () => {
    const text = block.join('\n').trim();
    const at = blockLine;
    block = [];
    if (!text || /^(-{3,}|\*{3,})$/.test(text)) return;
    const where = headings.filter(Boolean).join(' / ');
    atoms.push({ key: `${where ? `${where} / ` : ''}${lead(text)}`, heading_path: where, text, identity: identity(text), line: at });
  };
  for (const [index, line] of lines.entries()) {
    if (fence) { push(line, index); if (/^\s*```/.test(line)) { fence = false; flush(); } continue; }
    if (/^\s*```/.test(line)) { flush(); fence = true; push(line, index); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      // The first heading of the file is its title, not a section.
      if (firstHeading && level === 1) { firstHeading = false; continue; }
      firstHeading = false;
      headings.length = level - 1;
      headings[level - 1] = plain(heading[2]);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
      push(line, index);
      flush();
      continue;
    }
    // A new list item starts a new atom; indented continuation lines stay with it.
    if (/^(?:[-*]|\d+\.)\s+/.test(line) && block.length) flush();
    push(line, index);
  }
  flush();
  // A table's first row is its header when the next line was a separator; drop header rows.
  const headers = new Set();
  lines.forEach((line, index) => { if (/^\s*\|[\s|:-]+\|\s*$/.test(line) && index > 0) headers.add(lines[index - 1].trim()); });
  const kept = atoms.filter(atom => !headers.has(atom.text.trim()));
  // Two pieces with the same key get a number, in order, so every key is unique.
  const seen = new Map();
  return kept.map(atom => {
    const count = (seen.get(atom.key) ?? 0) + 1;
    seen.set(atom.key, count);
    return count === 1 ? atom : { ...atom, key: `${atom.key} (${count})` };
  });
}

// The second split rule: a mapping with `cut: "atoms"` cuts each document into atoms, and one row is one piece. The
// choice is DATA per list; the code knows no list. A piece found again, in the same document or another, adds a source
// to the row it matches and is never a second row.
//
//   { cut: "atoms", sources: [{ name, file }], record_type?: "note", id_prefix?: "note:", id_hex?: 32,
//     min_letters?: 0,              a piece with fewer letters or digits than this is not a row (a lone `{` or `},`)
//     most_sources?: Infinity,      a row lists at most this many places; `source_count` always says how many there were
//     most_text_bytes?: Infinity }  a row's text is at most this many bytes; `text_bytes` says the whole length
//
// Non-Negotiable Invariants:
//   1. Every atom of every document is counted exactly once: it makes a row, is added as a source to the row it matches,
//      or is too short to keep. The report names the three counts, and a cut whose counts differ is refused.
//   2. Two atoms of one identity make one row, whatever their keys; the first atom's key and place name the row.
//   3. A row's `sources` lists the documents and lines the piece was found at, in the order read, up to `most_sources`;
//      `source_count` is the true number. Text cut short by `most_text_bytes` says so (`text_clipped`), never silently.
//
//   splitAtoms(mapping, read) → { items: Map(id → { fields, parts }), leftover, report }
//   atomRecords(items, mapping) → [{ id, type, value }] for records:write
export async function splitAtoms(mapping, read) {
  if (!Array.isArray(mapping?.sources) || !mapping.sources.length) throw Object.assign(new Error('The mapping needs `sources`.'), { code: 'bad_input' });
  const items = new Map();
  let atomsIn = 0, sourcesAdded = 0, tooShort = 0, clipped = 0;
  const hex = mapping.id_hex ?? 32, minLetters = mapping.min_letters ?? 0;
  const mostSources = mapping.most_sources ?? Infinity, mostBytes = mapping.most_text_bytes ?? Infinity;
  for (const source of mapping.sources) {
    for (const atom of atomsOf(await read(source.file))) {
      atomsIn += 1;
      if (minLetters && (atom.text.match(/[\p{L}\p{N}]/gu) ?? []).length < minLetters) { tooShort += 1; continue; }
      const id = atom.identity.slice(3, 3 + hex);
      const place = { path: source.file, line: atom.line };
      const found = items.get(id);
      if (found) {
        sourcesAdded += 1; found.fields.source_count += 1;
        if (found.fields.sources.length < mostSources) found.fields.sources.push(place);
        continue;
      }
      const fields = { key: atom.key, heading_path: atom.heading_path, b3: atom.identity, sources: [place], source_count: 1 };
      let text = atom.text;
      const bytes = Buffer.byteLength(text);
      if (bytes > mostBytes) {
        text = Buffer.from(text).subarray(0, mostBytes).toString('utf8').replace(/�+$/, '');
        fields.text_bytes = bytes; fields.text_clipped = true; clipped += 1;
      }
      items.set(id, { fields, parts: [['text', text]] });
    }
  }
  if (items.size + sourcesAdded + tooShort !== atomsIn) throw Object.assign(new Error(`Atom accounting failed: ${items.size} rows, ${sourcesAdded} sources and ${tooShort} too short for ${atomsIn} atoms.`), { code: 'bad_input' });
  return { items, leftover: {}, report: { atoms_in: atomsIn, rows: items.size, found_again_as_a_source: sourcesAdded, too_short_to_keep: tooShort, rows_with_text_clipped: clipped } };
}

export function atomRecords(items, mapping = {}) {
  const type = mapping.record_type ?? 'note', prefix = mapping.id_prefix ?? 'note:';
  return [...items].map(([id, item]) => ({ id: `${prefix}${id}`, type, value: { ...item.fields, text: item.parts[0][1] } }));
}
