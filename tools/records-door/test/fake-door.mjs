// A stand-in for the records door: an MCP endpoint on this computer's loopback that keeps records in memory, checks
// the bearer capability and its rights, pages lists, and can answer busy or as an event stream, the way the engine's
// door does (tools/records-door/README.md, the contract).
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Engine-wide cap on the records one write carries (own-record-writes.json maxItems); a row may declare fewer.
const WRITE_CAP = 256;

export async function startFakeDoor({ rights = [], mostWrites = WRITE_CAP, records = [], busyFirst = 0, unknownFirst = 0, eventStream = false, pageCut = null } = {}) {
  const capability = 'run_fake_capability';
  const kept = new Map(records.map(record => [record.id, record]));
  const receipts = new Map();
  const calls = [];
  let busy = busyFirst;
  let unknown = unknownFirst;
  // A rights item names a kind, optionally narrowed to one id or an id prefix; a call passes when any item allows it.
  // An id right never lists; a prefix right lists only with no order and a prefix that starts with its own.
  const may = (kind, operation, { id, prefix, order } = {}) => rights.some(item => item.kind === kind && item.operations.includes(operation)
    && (item.id === undefined || (id !== undefined && id === item.id))
    && (item.prefix === undefined || (order === undefined && (id ?? prefix ?? '').startsWith(item.prefix))));
  // A refusal is a code and an outcome, with no words.
  const refuse = (code, outcome = 'not_started') => ({ isError: true, structuredContent: { code, outcome } });
  const OUTSIDE = 'current_workspace_rights_refused';
  const operations = {
    'records:read': ({ id, type }) => {
      if (!type || !may(type, 'records:read', { id })) return refuse(OUTSIDE);
      const held = kept.get(id);
      return { structuredContent: { id, type, value: held?.type === type ? held.value : null } };
    },
    'records:list': ({ type, prefix, order, limit = 50, after }) => {
      if (!may(type, 'records:list', { prefix, order })) return refuse(OUTSIDE);
      const ids = [...kept.values()].filter(record => record.type === type && (!prefix || record.id.startsWith(prefix))).map(record => record.id).sort().reverse();
      const from = after === undefined ? 0 : ids.indexOf(after) + 1;
      const size = Math.min(limit, pageCut ?? limit);
      const page = ids.slice(from, from + size);
      const next = from + size < ids.length ? page.at(-1) : null;
      return { structuredContent: { records: page.map(id => kept.get(id)), next } };
    },
    'records:write': ({ records: items }, key) => {
      if (receipts.has(key)) return { structuredContent: receipts.get(key) };
      if (!Array.isArray(items) || items.length < 1 || items.length > Math.min(mostWrites, WRITE_CAP)) return refuse('original_input_refused');
      for (const item of items) {
        const holds = kept.get(item.id)?.type;
        if (!item.type || item.id.includes('/') || !may(item.type, 'records:write', { id: item.id }) || (holds && !may(holds, 'records:write', { id: item.id }))) {
          return refuse(OUTSIDE);
        }
      }
      for (const item of items) item.value === null ? kept.delete(item.id) : kept.set(item.id, item);
      const receipt = { changed: items.length, write_count: items.length };
      receipts.set(key, receipt);
      // The write took effect, but the answer says its outcome is unknown: only the same key learns the receipt.
      if (unknown > 0) { unknown -= 1; return refuse('original_workspace_source_unavailable', 'unknown'); }
      return { structuredContent: receipt };
    },
  };
  const server = createServer((request, reply) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const args = body.params?.arguments ?? {};
      calls.push({ method: args.method, input: args.input, key: args.request_key, authorization: request.headers.authorization, protocol: request.headers['mcp-protocol-version'] });
      if (busy > 0) { busy -= 1; reply.writeHead(503).end(); return; }
      if (request.headers.authorization !== `Bearer ${capability}`) { reply.writeHead(401).end(); return; }
      const operation = operations[args.method];
      const result = operation ? operation(args.input ?? {}, args.request_key) : refuse('not_runnable_here');
      const answer = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (eventStream) reply.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${answer}\n\n`);
      else reply.writeHead(200, { 'content-type': 'application/json' }).end(answer);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const descriptor = join(mkdtempSync(join(tmpdir(), 'records-door-')), 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, resource: '@own-records', capability }));
  return { descriptor, calls, kept, capability, close: () => new Promise(done => server.close(done)) };
}
