// A stand-in for the records door: an MCP endpoint on this computer's loopback that keeps records in memory, checks
// the bearer capability and its rights, pages lists, and can answer busy or as an event stream, the way the engine's
// door does (tools/records-door/README.md, the contract). Given `files` ({ name: text }) and a files right, it is also
// the run's files door: the descriptor names `files_resource`, and list_files and read_file answer from those made-up
// files under the right's folder, a file's identity being the BLAKE3 identity of its bytes. Given `usageDays` (the engine's
// usage day rows, { day, stored_bytes, source_bytes_read, work_ms }, made up) and a files right to usage_days, it
// answers usage_days the way the engine's files door pages them: { days, next_after, stored_bytes_now }.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

// Engine-wide cap on the records one write carries (own-record-writes.json maxItems); a row may declare fewer.
const WRITE_CAP = 256;

const FILES_RESOURCE = '@own-files';
const FILE_SPAN = 65_536;

export async function startFakeDoor({ rights = [], mostWrites = WRITE_CAP, records = [], files = {}, usageDays = [], workspaceRecords = {}, workspaceEnvelope = {}, busyFirst = 0, unknownFirst = 0, eventStream = false, pageCut = null, bytePage = null, partialBodyFirst = 0, partialBodyAlways = false } = {}) {
  const capability = 'run_fake_capability';
  const kept = new Map(records.map(record => [record.id, record]));
  const receipts = new Map();
  const calls = [];
  let busy = busyFirst;
  let unknown = unknownFirst;
  let partialBodies = partialBodyFirst;
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
    'workspace:read': ({ selection }) => {
      const labels = selection?.labels, prefixes = selection?.prefixes;
      if (!Array.isArray(labels) || !labels.length || labels.length > 64 || !Array.isArray(prefixes) || prefixes.length !== 0
        || labels.some(label => typeof label !== 'string' || !label || label.length > 300) || new Set(labels).size !== labels.length) {
        return refuse('original_input_refused');
      }
      if (!labels.every(id => may('@own-records', 'workspace:read', { id }))) return refuse(OUTSIDE);
      const result = { records: Object.fromEntries(labels.filter(id => Object.hasOwn(workspaceRecords, id)).map(id => [id, workspaceRecords[id]])) };
      return { structuredContent: {
        content_type: 'application/json', status: 200, text: JSON.stringify(result), request_key: 'workspace-key', ...workspaceEnvelope,
      } };
    },
    // `limit` bounds the rows read; `where` keeps those whose named fields equal it (as JSON), `fields` narrows each value.
    'records:list': ({ type, prefix, order, limit = 50, after, fields, where, above, below, reverse = true }) => {
      if (!may(type, 'records:list', { prefix, order })) return refuse(OUTSIDE);
      if (!order && !reverse) return refuse('original_input_refused');
      const ids = [...kept.values()].filter(record => record.type === type && (!prefix || record.id.startsWith(prefix)) && (above === undefined || record.id > above) && (below === undefined || record.id < below)).map(record => record.id).sort().reverse();
      const from = after === undefined ? 0 : ids.indexOf(after) + 1;
      const size = Math.min(limit, pageCut ?? limit);
      const page = ids.slice(from, from + size);
      const next = from + size < ids.length ? page.at(-1) : null;
      const matches = record => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
      const shown = record => (fields ? { id: record.id, type: record.type, ...(fields.length ? { value: Object.fromEntries(fields.filter(name => name in (record.value ?? {})).map(name => [name, record.value[name]])) } : {}) } : record);
      return { structuredContent: { records: page.map(id => kept.get(id)).filter(matches).map(shown), next } };
    },
    // The records of the one kind a run may search that hold every asked word (an asked word starts a word of the text),
    // ranked 1 / (60 + rank), each with the records:read that opens it, the way the engine's records:search answers.
    'records:search': ({ question, type, limit = 60, ...rest }) => {
      if (Object.keys(rest).length || typeof question !== 'string' || !question.trim()) return refuse('original_input_refused');
      if (!type || !may(type, 'records:search')) return refuse(OUTSIDE);
      const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length >= 2);
      const held = record => { const words = JSON.stringify(record.value ?? {}).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; return terms.every(term => words.some(word => word.startsWith(term))); };
      const found = terms.length ? [...kept.values()].filter(record => record.type === type && held(record)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit) : [];
      const results = found.map((record, at) => ({ id: `record:${record.id}`, source: 'trillion', type, record: record.id, found_in: ['written'],
        address: { resource: '@own-records', operation: 'records:read', input: { id: record.id, type } }, score: 1 / (60 + at + 1) }));
      return { structuredContent: { question, terms, results, unavailable: [], pending: [] } };
    },
    'records:write': ({ records: items }, key) => {
      if (receipts.has(key)) return { structuredContent: receipts.get(key) };
      if (!Array.isArray(items) || items.length < 1 || items.length > Math.min(mostWrites, WRITE_CAP)) return refuse('original_input_refused');
      const before = new Map(kept);
      for (const item of items) {
        const holds = kept.get(item.id)?.type;
        if (!item.type || item.id.includes('/') || !may(item.type, 'records:write', { id: item.id }) || (holds && !may(holds, 'records:write', { id: item.id }))) {
          return refuse(OUTSIDE);
        }
        if (Object.hasOwn(item, 'expected')) {
          const expected = item.expected;
          const current = before.get(item.id) ?? null;
          if (expected === null) {
            if (current) return refuse('original_command_conflict');
          } else if (!expected || typeof expected !== 'object' || Array.isArray(expected)
            || typeof expected.type !== 'string' || !expected.value || typeof expected.value !== 'object' || Array.isArray(expected.value)) {
            return refuse('original_input_refused');
          } else if (!current || current.type !== expected.type || !isDeepStrictEqual(current.value, expected.value)) {
            return refuse('original_command_conflict');
          }
        }
      }
      for (const item of items) {
        const { expected: _expected, ...record } = item;
        item.value === null ? kept.delete(item.id) : kept.set(item.id, record);
      }
      const receipt = { changed: items.length, write_count: items.length };
      receipts.set(key, receipt);
      // The write took effect, but the answer says its outcome is unknown: only the same key learns the receipt.
      if (unknown > 0) { unknown -= 1; return refuse('original_workspace_source_unavailable', 'unknown'); }
      return { structuredContent: receipt };
    },
  };
  // The files door: a files right names the folder it reaches and the operations it may call there.
  const fileRights = rights.filter(item => typeof item.files === 'string');
  const mayFile = (operation, name) => fileRights.some(item => item.operations.includes(operation) && name.startsWith(item.files));
  const bytesOf = name => Buffer.from(files[name] ?? '', 'utf8');
  const fileOperations = {
    list_files: ({ folder = '/', after, limit = 50 }) => {
      const base = folder.endsWith('/') ? folder : `${folder}/`;
      if (!mayFile('list_files', base)) return refuse(OUTSIDE);
      const under = Object.keys(files).filter(name => name.startsWith(base)).sort();
      const names = under.filter(name => !name.slice(base.length).includes('/') && (!after || name > after));
      const shown = names.slice(0, limit);
      const folders = after ? [] : [...new Set(under.map(name => name.slice(base.length)).filter(rest => rest.includes('/')).map(rest => `${base}${rest.split('/')[0]}`))];
      return { structuredContent: { names: shown.map(name => ({ name, identity: makeHashCodeHexFromBytes(bytesOf(name)), byte_length: bytesOf(name).length })),
        next_after: shown.length < names.length ? shown.at(-1) : null, folders } };
    },
    read_file: ({ name_or_identity: wanted, offset = 0, length = FILE_SPAN }) => {
      const name = Object.keys(files).find(each => each === wanted || makeHashCodeHexFromBytes(bytesOf(each)) === wanted);
      if (!name || !mayFile('read_file', name)) return refuse(OUTSIDE);
      const bytes = bytesOf(name);
      const part = bytes.subarray(offset, offset + Math.min(length || FILE_SPAN, FILE_SPAN));
      return { structuredContent: { identity: makeHashCodeHexFromBytes(bytes), byte_length: bytes.length, offset, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') } };
    },
    usage_days: ({ after, limit = 50 }) => {
      if (!mayFile('usage_days', '/')) return refuse(OUTSIDE);
      const days = [...usageDays].sort((a, b) => a.day.localeCompare(b.day));
      const page = days.filter(row => !after || row.day > after).slice(0, limit);
      const more = page.length && days.at(-1).day > page.at(-1).day;
      return { structuredContent: { days: page, next_after: more ? page.at(-1).day : null, stored_bytes_now: days.at(-1)?.stored_bytes ?? 0 } };
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
      const operation = args.address === FILES_RESOURCE && fileRights.length ? fileOperations[args.method] : operations[args.method];
      const { after_byte: afterByte, ...input } = args.input ?? {};
      let result = operation ? operation(input, args.request_key) : refuse('not_runnable_here');
      // An answer bigger than `bytePage` comes as pages of its own bytes, the way the engine's door answers a record too
      // big for one message: a list's first row alone, then the same call with after_byte reads on.
      if (bytePage && !result.isError && (afterByte !== undefined || JSON.stringify(result.structuredContent).length > bytePage)) {
        const one = args.method === 'records:list' ? operation({ ...input, limit: 1 }, args.request_key) : result;
        const whole = Buffer.from(JSON.stringify(one.structuredContent));
        const offset = afterByte ?? 0;
        const part = whole.subarray(offset, offset + bytePage);
        result = { structuredContent: { byte_page: { total: whole.length, blake3: makeHashCodeHexFromBytes(whole).slice(3), offset, length: part.length,
          base64: part.toString('base64'), next_after_byte: offset + part.length < whole.length ? offset + part.length : null } } };
      }
      const answer = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (partialBodyAlways || partialBodies > 0) {
        if (partialBodies > 0) partialBodies -= 1;
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.flushHeaders();
        reply.write(answer.slice(0, Math.max(1, Math.floor(answer.length / 2))));
        setTimeout(() => reply.destroy(), 10);
        return;
      }
      if (eventStream) reply.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${answer}\n\n`);
      else reply.writeHead(200, { 'content-type': 'application/json' }).end(answer);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const descriptor = join(mkdtempSync(join(tmpdir(), 'records-door-')), 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, resource: '@own-records', capability,
    ...(fileRights.length ? { files_resource: FILES_RESOURCE } : {}) }));
  return { descriptor, calls, kept, capability, close: () => new Promise(done => server.close(done)) };
}
