// Tests on made-up transcript lines: usage parsing, partial last lines, cursor resume, and the SQL plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordTokens, sqlLiteral } from '../do-work/record-tokens.mjs';

const line = (o) => JSON.stringify(o) + '\n';
const assistant = (id, extra = {}) => ({
  type: 'assistant', sessionId: 's1', timestamp: '2026-11-21T12:00:00.000Z',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
  ...extra,
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const proj = path.join(root, 'projects', '-a-b');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');
  fs.writeFileSync(file, line(assistant('m1')) + line({ type: 'user' }) + line(assistant('m2', { isSidechain: true })));
  return { projects: path.join(root, 'projects'), file, root };
}

test('reads usage rows and writes a cursor past the last complete line', () => {
  const { projects, file, root } = fixture();
  const r = recordTokens({ projects_dir: projects, since_ms: 0, cursors: {} });
  assert.equal(r.stats.assistant_records, 2);
  assert.equal(r.cursor_updates[0].byte_offset, fs.statSync(file).size);
  assert.match(r.sql, /INSERT INTO claude_messages/);
  assert.match(r.sql, /ON CONFLICT \(message_id\) DO NOTHING/);
  assert.match(r.sql, /'claude-opus-5-5'/);
  fs.rmSync(root, { recursive: true });
});

test('a resumed run reads only new lines and skips a partial trailing line', () => {
  const { projects, file, root } = fixture();
  const first = recordTokens({ projects_dir: projects, since_ms: 0, cursors: {} });
  fs.appendFileSync(file, line(assistant('m3')) + '{"type":"assistant","mes');
  const second = recordTokens({ projects_dir: projects, since_ms: 0, cursors: { [file]: first.cursor_updates[0].byte_offset } });
  assert.equal(second.stats.assistant_records, 1);
  assert.equal(second.stats.partial_only, 0);
  assert.equal(second.cursor_updates[0].byte_offset, first.cursor_updates[0].byte_offset + Buffer.byteLength(line(assistant('m3'))));
  fs.rmSync(root, { recursive: true });
});

test('quotes are escaped in SQL literals and nulls are NULL', () => {
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(true), 'true');
});
