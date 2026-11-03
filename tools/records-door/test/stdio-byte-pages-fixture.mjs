// A fake MCP child for the stdio door: it answers one records:read in 3 byte pages, serves a page only to the first
// request key, and appends each request key it is sent to the file named by argv[2].
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const keysFile = process.argv[2];
const value = { type: 'note', value: { words: 'a value long enough to be split into three byte pages by the fake door' } };
const whole = new TextEncoder().encode(JSON.stringify(value));
const blake3 = makeHashCodeHexFromBytes(whole).slice(3);
const size = Math.ceil(whole.length / 3);
const starts = [0, size, 2 * size];
const refused = { isError: true, structuredContent: { code: 'original_input_refused', outcome: 'not_started' } };
let firstKey = null;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, params } = JSON.parse(line);
  const { method, input, request_key: key } = params.arguments;
  appendFileSync(keysFile, JSON.stringify({ method, key }) + '\n');
  firstKey ??= key;
  const index = starts.indexOf(input.after_byte ?? 0);
  if (key !== firstKey || method !== 'records:read' || index < 0) { console.log(JSON.stringify({ id, result: refused })); continue; }
  const offset = starts[index];
  const end = index === 2 ? whole.length : starts[index + 1];
  const part = whole.slice(offset, end);
  console.log(JSON.stringify({ id, result: { isError: false, structuredContent: { byte_page: {
    total: whole.length, blake3, offset, length: part.length,
    base64: Buffer.from(part).toString('base64'), next_after_byte: index === 2 ? null : end,
  } } } }));
}
