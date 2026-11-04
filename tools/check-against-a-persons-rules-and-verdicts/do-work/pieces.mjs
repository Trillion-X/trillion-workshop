// A method file broken into its smallest self-contained pieces (atoms), so every check can name the exact piece it
// came from and a change to one piece is seen as that piece changing.
//
// An atom is one paragraph, one list item, one table row or one fenced block, under the headings above it. Its key
// is the heading path plus the piece's lead (its bold opening, or its first words), so an edit inside a piece keeps
// its key and changes its identity, while a new piece arrives with a new key. Titles, horizontal rules and table
// headers are not atoms.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const LEAD_WORDS = 8;
const identity = text => `1f:${bytesToHex(blake3(new TextEncoder().encode(text.replace(/\s+/g, ' ').trim())))}`;
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
  let fence = false;
  let firstHeading = true;
  const flush = () => {
    const text = block.join('\n').trim();
    block = [];
    if (!text || /^(-{3,}|\*{3,})$/.test(text)) return;
    const where = headings.filter(Boolean).join(' / ');
    atoms.push({ key: `${where ? `${where} / ` : ''}${lead(text)}`, text, identity: identity(text) });
  };
  for (const line of lines) {
    if (fence) { block.push(line); if (/^\s*```/.test(line)) { fence = false; flush(); } continue; }
    if (/^\s*```/.test(line)) { flush(); fence = true; block.push(line); continue; }
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
      block.push(line);
      flush();
      continue;
    }
    // A new list item starts a new atom; indented continuation lines stay with it.
    if (/^(?:[-*]|\d+\.)\s+/.test(line) && block.length) flush();
    block.push(line);
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
