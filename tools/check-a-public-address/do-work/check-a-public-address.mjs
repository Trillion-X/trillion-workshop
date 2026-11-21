// tools/check-a-public-address/do-work/check-a-public-address.mjs
//
// Purpose: asks one public HTTP or HTTPS address and says whether the answer meets the expectations given with it. Any check
// that needs a public page or a public JSON answer uses this one tool; it names no product and no person.
//
//   input  { url, expect?: { status?, contains?: [..], json_path?, equals? } }
//   answer { url, status, content_type, body_bytes, excerpt, ok, failed: [..], error? }
//
// The request goes through the public-address guard (tools/http-client/do-work/node-public-fetch.mjs): a private, loopback,
// link-local or metadata address is refused before any connection, and every redirect is judged again. `failed` names each
// expectation that did not hold: 'status', 'contains:<marker>', 'json_path' (the path is missing or the body is not JSON) and
// 'equals'. A refused or failed request gives ok false with failed ['request'] and the reason in `error`.
//
// Run as a container tool: the input JSON arrives on stdin and the answer is printed as JSON on stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nodePublicFetch } from '../../http-client/do-work/node-public-fetch.mjs';

export const EXCERPT_CHARS = 2000;

// The dotted path with [n] indexes, from `$`: "$.clips[13].kind". Returns { found, value }. A path that does not exist is not found.
export function readPath(value, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) throw new Error('json_path must start with $.');
  const steps = path.slice(1).match(/\.[^.[]+|\[\d+\]/g) ?? [];
  if (path.slice(1).replace(/\.[^.[]+|\[\d+\]/g, '') !== '') throw new Error('json_path has a step this tool does not read.');
  let current = value;
  for (const step of steps) {
    const key = step.startsWith('[') ? Number(step.slice(1, -1)) : step.slice(1);
    if (current === null || typeof current !== 'object' || !(key in current)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

// Judges the answer against the expectations; returns the list of expectations that failed.
export function judge(expect, { status, body }) {
  const failed = [];
  if (expect.status !== undefined && status !== expect.status) failed.push('status');
  for (const marker of expect.contains ?? []) if (!body.includes(marker)) failed.push(`contains:${marker}`);
  if (expect.json_path !== undefined) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    const read = parsed === undefined ? { found: false } : readPath(parsed, expect.json_path);
    if (!read.found) failed.push('json_path');
    else if ('equals' in expect && JSON.stringify(read.value) !== JSON.stringify(expect.equals)) failed.push('equals');
  }
  return failed;
}

export async function checkAddress({ input, fetchImpl = nodePublicFetch() }) {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') throw new Error('url must be the address to check.');
  const expect = input.expect ?? {};
  let response;
  try {
    response = await fetchImpl(input.url, { redirect: 'follow' });
  } catch (error) {
    return { url: input.url, status: null, content_type: null, body_bytes: 0, excerpt: '', ok: false, failed: ['request'],
      error: error instanceof Error ? error.message : String(error) };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = bytes.toString('utf8');
  const failed = judge(expect, { status: response.status, body });
  return {
    url: input.url,
    status: response.status,
    content_type: response.headers.get('content-type'),
    body_bytes: bytes.length,
    excerpt: body.slice(0, EXCERPT_CHARS),
    ok: failed.length === 0,
    failed,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await checkAddress({ input })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
