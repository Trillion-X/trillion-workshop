// tools/check-against-a-persons-rules-and-verdicts/do-work/read-film-copy.mjs
//
// Purpose
//   The film readers: which text of a film's copy files is copy to check, as the person's layouts say (their settings
//   row's `readers`, never a file beside this code). A Markdown table is read by the column map for the file's name
//   ('*' otherwise), a column matching by the start of its lower-case header cell; fenced blocks of a named file are
//   post text; blockquotes are descriptions; a paragraph file is its plain paragraphs after a marker line; a .txt is one
//   unit a line; a .json is strings, { text, kind } rows or a words file. Moved from source-repo-a
//   tools/copy-gate/check.mjs (splitQuotes, cleanCell, readMarkdown, readFile, dedupe) one to one; what changed is that
//   the layouts and the file's text are handed in, so this file reads no file.
//
// Non-negotiable invariants
//   1. No layout, column name, kind or file name is in this file: every one is in `readers`, the person's DATA.
//   2. A cut line (struck through, or a cell a drop pattern names) is never copy; a cell split into parts is the split
//      kind the layouts name, so a list of labels is never judged as a sentence.
//   3. The same words of the same kind in the same judging context are one unit, with every other place they stand in
//      `also_at`, so one line is judged once.
//
// Shapes
//   readMarkdown(path, sourceText, readers) -> [{ text, kind, where: "<path>:<line>" }]
//   readFile(path, kind, sourceText, readers) -> units with `norm`ed text and a kind (default voiceover)
//   dedupe(units) -> units, each once, with also_at
//   readers: { files: { <name> | "*": { <header start>: { kind, quotes_are_units? } } }, fenced_blocks, blockquotes,
//     skip_sections, cell_drop_if, cell_strip, cell_split, split_parts_kind, cell_join, table_first_header_in,
//     table_skip_if_header_has, paragraph_files: { <name>: { kind, after } } }
import { basename, extname } from 'node:path';

export const norm = text => text.replace(/[’‘]/g, "'").replace(/[\r]/g, ' ');

function splitQuotes(cell) {
  cell = cell.replace(/\\"/g, "'");
  const body = cell.trim().replace(/\.+$/, '');
  if (body.startsWith('“') && body.endsWith('”')) {            // one curly quote that holds nested quotes is one unit
    let depth = 0, whole = true;
    for (let k = 0; k < body.length; k++) {
      depth += (body[k] === '“') - (body[k] === '”');
      if (depth === 0 && k < body.length - 1) { whole = false; break; }
    }
    if (whole) return [body.slice(1, -1)];
  }
  const found = [...cell.matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)].map(match => match[1] ?? match[2]);
  return found.length ? found : [cell];
}

function cleanCell(cell, readers) {
  for (const pattern of readers.cell_strip) cell = cell.replace(new RegExp(pattern, 'g'), '');
  for (const join of readers.cell_join) cell = cell.split(join).join(' ');
  return cell.trim();
}

export function readMarkdown(path, sourceText, readers) {
  const plain = (readers.paragraph_files ?? {})[basename(path)];
  if (plain) {                                         // a file whose copy is plain paragraphs after a marker line
    const lines = sourceText.split('\n');
    const start = lines.findIndex(line => new RegExp(plain.after).test(line));
    return lines.map((text, index) => ({ text: text.trim(), kind: plain.kind, where: `${path}:${index + 1}` }))
      .filter((unit, index) => index > start && unit.text && !unit.text.startsWith('#'));
  }
  const columns = readers.files[basename(path)] ?? readers.files['*'];
  const fenced = readers.fenced_blocks[basename(path)];
  const units = [];
  let header = null, colmap = null, section = '', inFence = false, quoteAt = -1;
  sourceText.split('\n').forEach((line, index) => {
    const at = `${path}:${index + 1}`;
    if (line.startsWith('```')) { inFence = !inFence; return; }
    if (inFence) {
      if (fenced && line.trim() && !readers.skip_sections.some(s => section.includes(s))) units.push({ text: line.trim(), kind: fenced, where: at });
      return;
    }
    if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); header = null; return; }
    if (line.startsWith('>')) {
      const text = line.replace(/^>\s?/, '').trim();
      if (text && quoteAt === index - 1 && units.length) units[units.length - 1].text += ` ${text}`;
      else if (text) units.push({ text, kind: readers.blockquotes, where: at });
      quoteAt = index;
      return;
    }
    if (!line.startsWith('|')) { header = null; return; }
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    if (header === null) {
      header = cells.map(cell => cell.toLowerCase());
      const ok = readers.table_first_header_in.includes(header[0]) && !readers.table_skip_if_header_has.some(word => header.join(' ').includes(word));
      colmap = new Map();
      if (ok) header.forEach((name, column) => {
        const match = Object.entries(columns).find(([start]) => name.startsWith(start));
        if (match) colmap.set(column, match[1]);
      });
      return;
    }
    if (/^[\s|:-]+$/.test(line)) return;
    for (const [column, spec] of colmap) {
      const raw = cells[column];
      if (raw === undefined || readers.cell_drop_if.some(p => new RegExp(p).test(raw.trim()))) continue;
      let parts = [raw], kind = spec.kind;
      if (spec.quotes_are_units) parts = splitQuotes(raw);
      else {
        for (const sep of readers.cell_split) parts = parts.flatMap(part => part.split(sep));
        if (parts.length > 1) kind = readers.split_parts_kind;
      }
      for (const part of parts) {
        const text = cleanCell(part, readers);
        if (text && !readers.cell_drop_if.some(p => new RegExp(p).test(text))) units.push({ text, kind, where: at });
      }
    }
  });
  return units;
}

export function readFile(path, kind = null, sourceText, readers) {
  let units;
  if (extname(path) === '.md') units = readMarkdown(path, sourceText, readers);
  else if (extname(path) === '.json') {
    let value = JSON.parse(sourceText);
    if (value && !Array.isArray(value) && typeof value.text === 'string') value = [value.text];
    else if (value && !Array.isArray(value)) value = value.units ?? value.lines ?? [];
    units = value.map((item, n) => ({ text: typeof item === 'string' ? item : item.text, kind: typeof item === 'string' ? null : item.kind ?? null, where: `${path}#${n}` }));
  } else {
    units = sourceText.split('\n').map((line, n) => ({ text: line.trim(), kind: null, where: `${path}:${n + 1}` }))
      .filter(unit => unit.text && !unit.text.startsWith('#'));
  }
  return units.map(unit => ({ ...unit, text: norm(unit.text), kind: kind ?? unit.kind ?? 'voiceover' }));
}

export function dedupe(units) {
  const seen = new Map();
  for (const unit of units) {
    const key = JSON.stringify([unit.kind, unit.text, unit.judge_field ?? unit.field ?? null, unit.path ?? [], unit.cue_id ?? null]);
    if (seen.has(key)) seen.get(key).also_at.push(unit.where);
    else seen.set(key, { ...unit, also_at: [] });
  }
  return [...seen.values()];
}
