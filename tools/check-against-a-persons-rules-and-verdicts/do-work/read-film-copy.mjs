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

function cleanCell(cell) {
  for (const pattern of readers.cell_strip) cell = cell.replace(new RegExp(pattern, 'g'), '');
  for (const join of readers.cell_join) cell = cell.split(join).join(' ');
  return cell.trim();
}

export function readMarkdown(path, sourceText = readFileSync(path, 'utf8')) {
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
        const text = cleanCell(part);
        if (text && !readers.cell_drop_if.some(p => new RegExp(p).test(text))) units.push({ text, kind, where: at });
      }
    }
  });
  return units;
}
