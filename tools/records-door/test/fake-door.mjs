// A stand-in for the records door: an MCP endpoint on this computer's loopback that keeps records in memory, checks
// the bearer capability and its rights, pages lists, and can answer busy or as an event stream, the way the engine's
// door does (tools/records-door/README.md, the contract). Given `files` ({ name: text }) and a files right, it is also
// the run's files door: the descriptor names `files_resource`, and list_files and read_file answer from those made-up
// files under the right's folder, a file's identity being the BLAKE3 identity of its bytes. `pageBytes` cuts a list
// page as the engine's door does, at the rows whose JSON fits (at least one, with a next while more remain), and
// `mostRequestBytes` refuses a request body over it with 413, as the door refuses one over its message. Given `usageDays` (the engine's
// usage day rows, { day, stored_bytes, source_bytes_read, work_ms }, made up) and a files right to usage_days, it
// answers usage_days the way the engine's files door pages them: { days, next_after, stored_bytes_now }. find_file
// finds a made-up file by name or identity, share_file answers a made-up signed link to one (under `shareOrigin`), and write_file_start / _piece / _finish keep a file sent in pieces under
// one upload id among the made-up files, so a run that keeps what it made reads it back.
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

// `runs` are the tool ids the row declares it may start (the brief's contract A): `tools:run` { tool, input } at the
// Workshop's address (`tools_resource`, @workshop-tools) answers `toolRuns[tool](input, key)` (or `{ started: true }`)
// for one of them, and refuses any other, as the engine does. Every nested run is kept in `runsStarted`.
const TOOLS_RESOURCE = '@workshop-tools';

// `fileAnswers` ({ operation: answer | (input) => answer | Error }) answers another files door operation (setup_facts ...)
// for a run whose files right names it at '/'.
export async function startFakeDoor({ fileAnswers = {}, runs = [], toolRuns = {}, rights = [], mostWrites = WRITE_CAP, records = [], files = {}, usageDays = [], workspaceRecords = {}, workspaceEnvelope = {}, busyFirst = 0, unknownFirst = 0, eventStream = false, pageCut = null, bytePage = null, partialBodyFirst = 0, partialBodyAlways = false, pageBytes = null, mostRequestBytes = null, shareOrigin = 'https://files.example.com' } = {}) {
  const capability = 'run_fake_capability';
  // The ids of each kind, sorted once for every page of a list until anything kept changes (a test may change it too).
  const sorted = new Map();
  const kept = new (class extends Map {
    set(id, record) { sorted.clear(); return super.set(id, record); }
    delete(id) { sorted.clear(); return super.delete(id); }
    clear() { sorted.clear(); return super.clear(); }
  })(records.map(record => [record.id, record]));
  const receipts = new Map();
  const calls = [];
  const runsStarted = [];
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
  const EVERY_KIND = '*';
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
      if (!sorted.has(type)) sorted.set(type, [...kept.values()].filter(record => record.type === type).map(record => record.id).sort().reverse());
      const ids = sorted.get(type).filter(id => (!prefix || id.startsWith(prefix)) && (above === undefined || id > above) && (below === undefined || id < below));
      const from = after === undefined ? 0 : ids.indexOf(after) + 1;
      let size = Math.min(limit, pageCut ?? limit);
      const matches = record => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
      const shown = record => (fields ? { id: record.id, type: record.type, ...(fields.length ? { value: Object.fromEntries(fields.filter(name => name in (record.value ?? {})).map(name => [name, record.value[name]])) } : {}) } : record);
      const rows = [];
      if (pageBytes) {
        // The rows read stop where the shown rows' JSON would pass the page's bytes (at least one row is read).
        let held = 0, read = 0;
        for (const id of ids.slice(from, from + size)) {
          const record = kept.get(id);
          const one = matches(record) ? shown(record) : null;
          const cost = one ? JSON.stringify(one).length + 1 : 0;
          if (read && held + cost > pageBytes) break;
          read += 1; held += cost;
          if (one) rows.push(one);
        }
        size = read;
      }
      const page = ids.slice(from, from + size);
      const next = from + size < ids.length ? page.at(-1) : null;
      return { structuredContent: { records: pageBytes ? rows : page.map(id => kept.get(id)).filter(matches).map(shown), next } };
    },
    // The records a run may search that hold every asked word (an asked word starts a word of the text), each kind its
    // own lane ranked 1 / (60 + rank), each with the records:read that opens it, the way the engine's records:search
    // answers. With `type` the run needs a search right on that kind; with none, the read-only right over every kind,
    // { kind: '*', operations: ['records:search'] } (trillion-rust records-door.json run_operations `every_kind`), and
    // '*' named as a type is not a kind.
    'records:search': ({ question, type, limit = 60, ...rest }) => {
      if (Object.keys(rest).length || typeof question !== 'string' || !question.trim()) return refuse('original_input_refused');
      if (type === EVERY_KIND || (type ? !may(type, 'records:search') : !may(EVERY_KIND, 'records:search'))) return refuse(OUTSIDE);
      const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length >= 2);
      const held = record => { const words = JSON.stringify(record.value ?? {}).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; return terms.every(term => words.some(word => word.startsWith(term))); };
      const found = terms.length ? [...kept.values()].filter(record => (!type || record.type === type) && held(record)).sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
      const lanes = new Map();
      for (const record of found) lanes.set(record.type, [...(lanes.get(record.type) ?? []), record]);
      const results = [...lanes.values()].flatMap(lane => lane.map((record, at) => ({ id: `record:${record.id}`, source: 'trillion', type: record.type,
        record: record.id, found_in: ['written'], address: { resource: '@own-records', operation: 'records:read', input: { id: record.id, type: record.type } },
        score: 1 / (60 + at + 1) }))).sort((a, b) => b.score - a.score || (a.record < b.record ? -1 : 1)).slice(0, limit);
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
  const stored = new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
  const bytesOf = name => stored.get(name) ?? Buffer.alloc(0);
  const uploads = new Map();
  const fileOperations = {
    // The files whose names hold every asked word, scored 0.8 / (60 + rank), each with the find_file that opens it. Its
    // rule names no folder, so only a right on every name ("/") covers it.
    search: ({ question, limit = 60 }) => {
      if (!fileRights.some(item => item.files === '/' && item.operations.includes('search'))) return refuse(OUTSIDE);
      const terms = [...new Set(String(question ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length >= 2);
      const named = name => { const words = name.split('/').at(-1).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; return terms.every(term => words.some(word => word.startsWith(term))); };
      const results = (terms.length ? Object.keys(files).filter(named).sort() : []).slice(0, limit).map((path, at) => ({ id: `file:${path}`, source: 'files',
        name: path.split('/').at(-1), path, found_in: ['name'], address: { resource: FILES_RESOURCE, operation: 'find_file', input: { name_or_identity: path } },
        score: 0.8 / (60 + at + 1) }));
      return { structuredContent: { question, terms, results, unavailable: [], pending: [] } };
    },
    list_files: ({ folder = '/', after, limit = 50 }) => {
      const base = folder.endsWith('/') ? folder : `${folder}/`;
      if (!mayFile('list_files', base)) return refuse(OUTSIDE);
      const under = [...stored.keys()].filter(name => name.startsWith(base)).sort();
      const names = under.filter(name => !name.slice(base.length).includes('/') && (!after || name > after));
      const shown = names.slice(0, limit);
      const folders = after ? [] : [...new Set(under.map(name => name.slice(base.length)).filter(rest => rest.includes('/')).map(rest => `${base}${rest.split('/')[0]}`))];
      return { structuredContent: { names: shown.map(name => ({ name, identity: makeHashCodeHexFromBytes(bytesOf(name)), byte_length: bytesOf(name).length })),
        next_after: shown.length < names.length ? shown.at(-1) : null, folders } };
    },
    read_file: ({ name_or_identity: wanted, offset = 0, length = FILE_SPAN }) => {
      const name = [...stored.keys()].find(each => each === wanted || makeHashCodeHexFromBytes(bytesOf(each)) === wanted);
      if (!name || !mayFile('read_file', name)) return refuse(OUTSIDE);
      const bytes = bytesOf(name);
      const part = bytes.subarray(offset, offset + Math.min(length || FILE_SPAN, FILE_SPAN));
      return { structuredContent: { identity: makeHashCodeHexFromBytes(bytes), byte_length: bytes.length, offset, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') } };
    },
    // A signed link to a made-up file that expires after `seconds`, the way the engine's files door shares one for a
    // place to fetch: { url, identity, byte_length, expires_at }. The link is made up, under `shareOrigin`; nothing
    // answers it here.
    share_file: ({ name_or_identity: wanted, seconds = 3600 }) => {
      const name = [...stored.keys()].find(each => each === wanted || makeHashCodeHexFromBytes(bytesOf(each)) === wanted);
      if (!name || !mayFile('share_file', name)) return refuse(OUTSIDE);
      const identity = makeHashCodeHexFromBytes(bytesOf(name));
      const expires = new Date(Date.now() + Math.max(1, Number(seconds) || 3600) * 1000);
      const url = `${shareOrigin}/shared/${encodeURIComponent(identity)}?expires=${Math.floor(expires.getTime() / 1000)}&signature=made-up`;
      return { structuredContent: { url, identity, byte_length: bytesOf(name).length, expires_at: expires.toISOString() } };
    },
    find_file: ({ name_or_identity: wanted }) => {
      const name = [...stored.keys()].find(each => each === wanted || makeHashCodeHexFromBytes(bytesOf(each)) === wanted);
      if (!name || !mayFile('find_file', name)) return refuse(OUTSIDE);
      return { structuredContent: { identity: makeHashCodeHexFromBytes(bytesOf(name)), byte_length: bytesOf(name).length, names: [name] } };
    },
    write_file_start: ({ upload_id: id, name, byte_length: length }) => {
      if (typeof name !== 'string' || !mayFile('write_file_start', name)) return refuse(OUTSIDE);
      const upload = uploads.get(id) ?? { name, length, pieces: new Map() };
      uploads.set(id, upload);
      const next = [...upload.pieces.values()].reduce((sum, piece) => sum + piece.length, 0);
      return { structuredContent: { upload_id: id, next_offset: next } };
    },
    write_file_piece: ({ upload_id: id, name, offset, content_base64: content }) => {
      const upload = uploads.get(id);
      if (!upload || upload.name !== name || !mayFile('write_file_piece', name)) return refuse(OUTSIDE);
      upload.pieces.set(offset, Buffer.from(content ?? '', 'base64'));
      return { structuredContent: { upload_id: id, next_offset: offset + upload.pieces.get(offset).length } };
    },
    write_file_finish: ({ upload_id: id, name }) => {
      const upload = uploads.get(id);
      if (!upload || upload.name !== name || !mayFile('write_file_finish', name)) return refuse(OUTSIDE);
      const bytes = Buffer.concat([...upload.pieces].sort(([a], [b]) => a - b).map(([, piece]) => piece));
      if (Number.isInteger(upload.length) && bytes.length !== upload.length) return refuse('incomplete_upload');
      stored.set(name, bytes);
      return { structuredContent: { identity: makeHashCodeHexFromBytes(bytes), name, byte_length: bytes.length } };
    },
    usage_days: ({ after, limit = 50 }) => {
      if (!mayFile('usage_days', '/')) return refuse(OUTSIDE);
      const days = [...usageDays].sort((a, b) => a.day.localeCompare(b.day));
      const page = days.filter(row => !after || row.day > after).slice(0, limit);
      const more = page.length && days.at(-1).day > page.at(-1).day;
      return { structuredContent: { days: page, next_after: more ? page.at(-1).day : null, stored_bytes_now: days.at(-1)?.stored_bytes ?? 0 } };
    },
  };
  const runOperation = ({ tool, input }, key) => {
    if (typeof tool !== 'string' || !runs.includes(tool)) return refuse(OUTSIDE);
    runsStarted.push({ tool, input, key });
    const answer = toolRuns[tool];
    if (answer instanceof Error) return refuse(answer.message);
    if (typeof answer !== 'function') return { structuredContent: answer ?? { started: true } };
    return Promise.resolve(answer(input, key)).then(structuredContent => ({ structuredContent }), error => refuse(error.message));
  };
  const server = createServer((request, reply) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const sent = Buffer.concat(chunks);
      if (mostRequestBytes && sent.length > mostRequestBytes) { calls.push({ refused_bytes: sent.length }); reply.writeHead(413).end(); return; }
      const body = JSON.parse(sent.toString('utf8'));
      const args = body.params?.arguments ?? {};
      calls.push({ method: args.method, input: args.input, key: args.request_key, authorization: request.headers.authorization, protocol: request.headers['mcp-protocol-version'] });
      if (busy > 0) { busy -= 1; reply.writeHead(503).end(); return; }
      if (request.headers.authorization !== `Bearer ${capability}`) { reply.writeHead(401).end(); return; }
      const answered = args.address === FILES_RESOURCE && Object.hasOwn(fileAnswers, args.method) ? input => {
        if (!fileRights.some(item => item.files === '/' && item.operations.includes(args.method))) return refuse(OUTSIDE);
        const answer = typeof fileAnswers[args.method] === 'function' ? fileAnswers[args.method](input) : fileAnswers[args.method];
        return answer instanceof Error ? refuse(answer.message) : { structuredContent: answer };
      } : null;
      const operation = answered ?? (args.address === TOOLS_RESOURCE ? (args.method === 'tools:run' && runs.length ? runOperation : null)
        : args.method === 'tools:run' ? null
        : args.address === FILES_RESOURCE && fileRights.length ? fileOperations[args.method] : operations[args.method]);
      const { after_byte: afterByte, ...input } = args.input ?? {};
      let result = operation ? await operation(input, args.request_key) : refuse('not_runnable_here');
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
    ...(fileRights.length ? { files_resource: FILES_RESOURCE } : {}), ...(runs.length ? { tools_resource: TOOLS_RESOURCE } : {}) }));
  // stored: the made-up files by name, the ones a run wrote among them.
  return { descriptor, calls, kept, stored, capability, runsStarted, close: () => new Promise(done => server.close(done)) };
}
