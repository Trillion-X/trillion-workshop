// The stdio MCP door asks for later byte pages with the request key of the first call, as the records door does:
// the engine serves later pages only to the key that made the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStdioRecordsDoor } from '../read-data/stdio-mcp-door.mjs';

const fixture = fileURLToPath(new URL('./stdio-byte-pages-fixture.mjs', import.meta.url));

test('every byte page of a stdio records:read is asked for with the first call\'s request key', async () => {
  const keysFile = join(mkdtempSync(join(tmpdir(), 'stdio-door-page-key-')), 'keys.jsonl');
  const door = openStdioRecordsDoor({ argv: [process.execPath, fixture, keysFile], timeout_ms: 5000 });
  let record;
  try { record = await door.readRecord('note', 'note:big'); }
  finally { await door.close(); }
  const calls = readFileSync(keysFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(record, { type: 'note', value: { words: 'a value long enough to be split into three byte pages by the fake door' } }, 'the joined pages are the whole record');
  assert.equal(calls.length, 3, 'three pages, three calls');
  assert.ok(calls.every(({ method, key }) => method === 'records:read' && key === calls[0].key), `every call carried the same request_key: ${JSON.stringify(calls)}`);
});
