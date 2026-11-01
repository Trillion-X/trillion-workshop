// The configured MCP client owns authentication; credentials never enter this adapter.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { recordsDoorFromCall, RecordsDoorError } from './records-door.mjs';
import { wholeAnswer } from './byte-pages.mjs';

export function openStdioRecordsDoor({ argv, resource = '@own-records', timeout_ms = 30000, max_answer_bytes = 16 * 1024 * 1024 } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(word => typeof word !== 'string' || !word)) throw new TypeError('The MCP client needs a nonempty argv array.');
  if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) throw new TypeError('The MCP client needs a positive call timeout.');
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let sequence = 0, buffer = '', closed = false;
  const fail = (code, words) => {
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new RecordsDoorError(code, words, 'unknown')); }
    pending.clear();
  };
  child.on('error', () => fail('mcp_client_unavailable', 'The configured MCP client could not start.'));
  child.on('close', () => fail('mcp_client_closed', 'The configured MCP client closed before answering.'));
  child.stdin.on('error', () => fail('mcp_client_closed', 'The configured MCP client stopped accepting requests.'));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => {
    buffer += text;
    if (Buffer.byteLength(buffer) > max_answer_bytes) { fail('mcp_answer_too_large', 'The MCP client answer exceeds the declared bound.'); child.kill(); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let answer;
      try { answer = JSON.parse(line); }
      catch { fail('mcp_invalid_answer', 'The MCP client returned invalid JSON.'); child.kill(); return; }
      const waiting = pending.get(answer.id);
      if (!waiting) continue;
      pending.delete(answer.id); clearTimeout(waiting.timer); waiting.resolve(answer);
    }
  });
  async function request(message) {
    if (closed) throw new RecordsDoorError('mcp_client_closed', 'The configured MCP client is closed.', 'not_started');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail('mcp_client_timeout', 'The MCP client did not answer within its declared timeout.'); child.kill(); }, timeout_ms);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
    });
  }
  async function once(method, input, request_key, address) {
    let answer;
    for (let attempt = 0; ; attempt++) {
      answer = await request({ method: 'tools/call', params: { name: 'run_resource_operation', arguments: { address, method, request_key, input } } });
      const failure = answer.result?.isError ? answer.result.structuredContent : null;
      if (attempt >= 5 || !(failure?.code === 'selected_owner_unavailable' || failure?.outcome === 'unknown')) break;
      await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
    }
    if (answer.error) throw new RecordsDoorError('mcp_transport_error', 'The MCP client could not reach the account.', 'unknown');
    const result = answer.result;
    if (!result || typeof result !== 'object') throw new RecordsDoorError('mcp_invalid_answer', 'The MCP client returned no operation result.', 'unknown');
    if (result.isError) {
      const { code = 'refused', outcome = null } = result.structuredContent ?? {};
      throw new RecordsDoorError(code, `The account refused the operation (${code}).`, outcome);
    }
    if (!Object.hasOwn(result, 'structuredContent')) throw new RecordsDoorError('mcp_invalid_answer', 'The MCP client returned no typed answer.', 'unknown');
    return result.structuredContent;
  }
  async function call(method, input, key = `${method}:${randomUUID()}`, address = resource) {
    return wholeAnswer(await once(method, input, key, address), after => once(method, { ...input, after_byte: after }, `${method}:${randomUUID()}`, address));
  }
  return { ...recordsDoorFromCall(call, { resource }), async close() {
    if (closed) return;
    const finished = new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000);
    await finished; clearTimeout(timer);
  } };
}
