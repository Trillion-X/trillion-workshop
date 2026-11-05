// parts/public-sales-page/do-work/write-a-sales-page.mjs
//
// The Workshop tool "Write a sales or landing page". Reads one page row as JSON (argv[2], see
// read-data/sales-page.mjs), writes the whole page as one HTML file at argv[3], which the Workshop keeps in the
// person's files, and prints one JSON line: the page's title, how many sections it has, its size and its BLAKE3
// identity, and the words on it (so the caller can check what it says without opening it).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { salesPageHtml } from '../read-data/sales-page.mjs';

const look = () => readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/screen-look/show/sales-page.css')), 'utf8');

// The visible words of a page row, top to bottom: what a reader of the page reads.
const wordsOf = row => row.sections.flatMap(section => [section.heading, section.body,
  ...(section.items ?? []).flatMap(item => [item.heading, item.body, ...(item.details ?? [])]),
  ...(section.cards ?? []).flatMap(card => [card.heading, card.body, ...(card.details ?? [])]),
  ...(section.actions ?? []).map(action => action.label)]).filter(value => typeof value === 'string' && value.trim()).join('\n');

export function writeASalesPage(row, out) {
  const html = salesPageHtml(row, look());
  const bytes = utf8ToBytes(html);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, bytes); }
  return { title: row.title, sections: row.sections.length, bytes: bytes.length, identity: `1f:${bytesToHex(blake3(bytes))}`, words: wordsOf(row) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(writeASalesPage(JSON.parse(process.argv[2] ?? '{}'), process.argv[3]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
