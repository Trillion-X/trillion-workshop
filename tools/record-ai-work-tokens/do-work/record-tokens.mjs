// Reads Claude Code transcript files from a projects folder, from each file's saved byte cursor, and returns the usage rows and the SQL that records them. It writes nothing itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'table.json'), 'utf8'));

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
}

// One complete line at a time. A trailing partial line is left for the next run.
export function readNewMessages(file, offset, stats) {
  const size = fs.statSync(file).size;
  const start = offset > size ? 0 : offset;
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) {
    stats.partial_only += 1;
    return { rows: [], newOffset: start, size };
  }
  const complete = buf.subarray(0, lastNl + 1).toString('utf8');
  const rows = [];
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { stats.bad_line += 1; continue; }
    if (rec.type !== 'assistant') continue;
    const msg = rec.message || {};
    const usage = msg.usage;
    if (!usage || !msg.id || !rec.timestamp) continue;
    rows.push({
      message_id: msg.id,
      session_id: rec.sessionId || rec.session_id || null,
      path: file,
      sidechain: Boolean(rec.isSidechain),
      model: msg.model || 'unknown',
      at: rec.timestamp,
      input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      cache_write_tokens: Number(usage.cache_creation_input_tokens || 0),
      cache_read_tokens: Number(usage.cache_read_input_tokens || 0),
      project: path.basename(path.dirname(file)),
    });
  }
  stats.assistant_records += rows.length;
  return { rows, newOffset: start + lastNl + 1, size };
}

// Every .jsonl under the projects folder, modified on or after `since` (ms since epoch).
export function listTranscripts(projectsDir, since) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= since) out.push(p);
    }
  };
  walk(projectsDir);
  return out.sort();
}

// request: { projects_dir, since_ms, cursors: { [path]: byte_offset } }
export function recordTokens(request) {
  const stats = { files_seen: 0, files_read: 0, assistant_records: 0, bad_line: 0, partial_only: 0 };
  const cursors = request.cursors || {};
  const sinceMs = request.since_ms ?? 0;
  const statements = [];
  const cursorUpdates = [];
  for (const file of listTranscripts(request.projects_dir, sinceMs)) {
    stats.files_seen += 1;
    const { rows, newOffset, size } = readNewMessages(file, cursors[file] ?? 0, stats);
    if (newOffset === (cursors[file] ?? 0) && rows.length === 0) continue;
    stats.files_read += 1;
    if (rows.length) {
      statements.push(
        `INSERT INTO ${TABLE.table} (${TABLE.columns.join(', ')}) VALUES\n` +
          rows.map((r) => '(' + TABLE.columns.map((c) => sqlLiteral(r[c])).join(',') + ')').join(',\n') +
          `\nON CONFLICT (${TABLE.key}) DO NOTHING;`,
      );
    }
    cursorUpdates.push({ path: file, byte_offset: newOffset, file_bytes: size });
  }
  for (const u of cursorUpdates) {
    statements.push(
      `INSERT INTO ${TABLE.cursor_table} (path, byte_offset, file_bytes, status, updated_at) VALUES ` +
        `(${sqlLiteral(u.path)}, ${u.byte_offset}, ${u.file_bytes}, 'reading', now()) ` +
        `ON CONFLICT (path) DO UPDATE SET byte_offset = EXCLUDED.byte_offset, file_bytes = EXCLUDED.file_bytes, status = 'reading', updated_at = now();`,
    );
  }
  const sql = `SET statement_timeout='${TABLE.statement_timeout}';\nBEGIN;\n${statements.join('\n')}\nCOMMIT;\n`;
  return { stats, cursor_updates: cursorUpdates, sql };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = recordTokens(request);
  process.stdout.write(JSON.stringify({ result: { stats: result.stats, cursor_updates: result.cursor_updates.length, sql: result.sql } }) + '\n');
}
