// Disposable integration verification for the published ledger row. The records door is backed by an on-disk
// append-only JSONL journal so a new run process can reopen every record and write receipt after restart.
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import rows from '../tool-rows.json' with { type: 'json' };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [inputPath, summaryPath] = process.argv.slice(2);
if (!inputPath) throw new Error('usage: node verify-journal-import.mjs <append-input.json> [summary.json]');
const request = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
if (request.action !== 'append' || !Array.isArray(request.observations) || !request.request_key) throw new TypeError('expected a prepared append input');
const row = rows.records.find(item => item.payload.id === 'tool:cost-measurement-ledger').payload;
const journalDir = mkdtempSync(join(tmpdir(), 'measurement-ledger-journal-'));
const journal = join(journalDir, 'records.jsonl');
const descriptor = join(journalDir, 'door.json');
const records = new Map();
const receipts = new Map();
const cap = 'disposable_journal_capability';
const rights = row.invoke.records.rights;
const may = (type, op) => rights.some(item => item.kind === type && item.operations.includes(op));
if (existsSync(journal)) for (const line of readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const entry = JSON.parse(line);
  for (const record of entry.records) records.set(record.id, record);
  receipts.set(entry.key, { changed: entry.records.length, write_count: entry.records.length });
}
const conflict = () => ({ isError: true, structuredContent: { code: 'original_command_conflict', outcome: 'not_started' } });
const refuse = () => ({ isError: true, structuredContent: { code: 'current_workspace_rights_refused', outcome: 'not_started' } });
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const args = body.params?.arguments ?? {};
    if (req.headers.authorization !== `Bearer ${cap}`) { res.writeHead(401).end(); return; }
    const input = args.input ?? {};
    let result;
    if (args.method === 'records:read') {
      const held = records.get(input.id);
      result = !may(input.type, 'records:read') ? refuse() : { structuredContent: { id: input.id, type: input.type, value: held?.type === input.type ? held.value : null } };
    } else if (args.method === 'records:list') {
      if (!may(input.type, 'records:list')) result = refuse();
      else {
        const ids = [...records.values()].filter(r => r.type === input.type && (!input.prefix || r.id.startsWith(input.prefix))).map(r => r.id).sort().reverse();
        const start = input.after === undefined ? 0 : ids.indexOf(input.after) + 1;
        const page = ids.slice(start, start + Math.min(input.limit ?? 999, 999));
        result = { structuredContent: { records: page.map(id => records.get(id)), next: start + page.length < ids.length ? page.at(-1) : null } };
      }
    } else if (args.method === 'records:write') {
      if (receipts.has(args.request_key)) result = { structuredContent: receipts.get(args.request_key) };
      else {
        const items = input.records;
        if (!Array.isArray(items) || !items.length || items.length > row.invoke.records.most_writes) result = refuse();
        else if (items.some(item => !may(item.type, 'records:write') || records.has(item.id) || item.expected !== null)) result = conflict();
        else {
          const saved = items.map(({ expected: _expected, ...record }) => record);
          appendFileSync(journal, `${JSON.stringify({ key: args.request_key, records: saved })}\n`);
          for (const record of saved) records.set(record.id, record);
          const receipt = { changed: saved.length, write_count: saved.length };
          receipts.set(args.request_key, receipt);
          result = { structuredContent: receipt };
        }
      }
    } else result = refuse();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
});

function localize(word) {
  if (word.startsWith('/opt/records-door/')) return join(repo, 'tools/records-door/', word.slice('/opt/records-door/'.length));
  if (word.startsWith('/opt/measurement-ledger/')) return join(repo, 'tools/measurement-ledger/', word.slice('/opt/measurement-ledger/'.length));
  return word;
}
async function run(input) {
  const [command, ...args] = row.invoke.argv.map(localize);
  const fd = openSync(descriptor, 'r');
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe', fd] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', rejectRun);
      child.on('close', code => {
        if (code !== 0) return rejectRun(new Error(`ledger row process exited ${code}: ${stderr}\n${stdout.slice(-2000)}`));
        try { resolveRun(JSON.parse(stdout.trim().split('\n').at(-1)).result); } catch (error) { rejectRun(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  } finally { closeSync(fd); }
}

try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  writeFileSync(descriptor, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, resource: '@own-records', capability: cap }));
  const inserted = await run(request);
  assert.equal(inserted.inserted, request.observations.length);
  assert.equal(inserted.replayed, 0);
  assert.equal(records.size, request.observations.length);
  const expected = new Map(request.observations.map(o => [`record:cost-measurement-observation:${encodeURIComponent(o.event_id)}`, { schema: 2, ...o }]));
  for (const [id, value] of expected) assert.ok(isDeepStrictEqual(records.get(id)?.value, value), `journal readback mismatch: ${id}`);
  const journalLineCount = readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).length;

  // A separate Node process reopens the durable journal and runs the same append request again.
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  records.clear(); receipts.clear();
  for (const line of readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    for (const record of entry.records) records.set(record.id, record);
    receipts.set(entry.key, { changed: entry.records.length, write_count: entry.records.length });
  }
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  writeFileSync(descriptor, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, resource: '@own-records', capability: cap }));
  const replay = await run(request);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.replayed, request.observations.length);
  assert.equal(readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).length, journalLineCount);

  const summary = { records: records.size, first_process_inserted: inserted.inserted, second_process_replayed: replay.replayed,
    journal_write_batches: journalLineCount, exact_record_readbacks: expected.size, journal_rewritten_on_replay: false,
    request_key: request.request_key, record_type: 'record:cost-measurement-observation', disposable_journal: true };
  if (summaryPath) writeFileSync(resolve(summaryPath), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(done => server.close(done));
  rmSync(journalDir, { recursive: true, force: true });
}
