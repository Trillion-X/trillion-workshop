// Later byte pages of an answer are asked for with the request key of the first call: the engine serves later pages
// only to the key that made the answer (trillion-rust src/runtime/workshop.rs), and a new key can run the operation again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecordsDoor } from '../read-data/records-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

test('every byte page of a records:read is asked for with the first call\'s request key', async () => {
  const value = { type: 'note', value: { words: 'a value long enough to be split into three byte pages by the fake door' } };
  const whole = new TextEncoder().encode(JSON.stringify(value));
  const blake3 = makeHashCodeHexFromBytes(whole).slice(3);
  const size = Math.ceil(whole.length / 3);
  const starts = [0, size, 2 * size];

  const dir = mkdtempSync(join(tmpdir(), 'records-door-page-key-'));
  const descriptor = join(dir, 'door.json');
  writeFileSync(descriptor, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', resource: 'records:test', capability: 'cap-secret' }));

  const keys = [];
  let firstKey = null;
  const reply = payload => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (_url, { body }) => {
    const { request_key: key, input, method } = JSON.parse(body).params.arguments;
    assert.equal(method, 'records:read');
    keys.push(key);
    firstKey ??= key;
    if (key !== firstKey) return reply({ isError: true, structuredContent: { code: 'original_input_refused', outcome: 'not_started' } });
    const offset = input.after_byte ?? 0;
    const index = starts.indexOf(offset);
    if (index < 0) return reply({ isError: true, structuredContent: { code: 'original_input_refused', outcome: 'not_started' } });
    const end = index === 2 ? whole.length : starts[index + 1];
    const part = whole.slice(offset, end);
    return reply({ structuredContent: { byte_page: {
      total: whole.length, blake3, offset, length: part.length,
      base64: Buffer.from(part).toString('base64'), next_after_byte: index === 2 ? null : end,
    } } });
  };

  const door = openRecordsDoor({ descriptor, fetchImpl, wait: async () => {} });
  const record = await door.readRecord('note', 'note:big');
  assert.deepEqual(record, value, 'the joined pages are the whole record');
  assert.equal(keys.length, 3, 'three pages, three calls');
  assert.ok(keys.every(key => key === keys[0]), `every call carried the same request_key: ${JSON.stringify(keys)}`);
});
