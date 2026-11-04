#!/usr/bin/env node
// harness/decide-before-building.mjs
//
// Purpose
//   A pre-tool hook for any AI coding harness (Claude Code, Codex, anything that runs a command before a tool call and
//   reads a refusal from it). It refuses a change to a lasting file (an edit or write inside a git repository, or a git
//   commit) until the same turn has made a Trillion decision: a call to one of the deciding tools whose answer came back
//   in Trillion's terminal decision shape. A case id only means the method was opened. A reminder to decide first was skipped by the people who wrote it; a refusal at the moment of the change
//   holds every time.
//
// Non-negotiable invariants
//   1. Nothing here names a project, a product or a harness: which tools change files, which calls decide and which
//      folders are free are DATA in decide-before-building.json beside this file.
//   2. A turn is everything after the person's last message. Only decide or an export of an already decided case counts;
//      start_decision, next_question and answer_question never certify a terminal choice.
//      Compaction continues that turn: generated summaries are neither a new person request nor decision evidence.
//   3. Nothing is kept. The hook reads the harness's own transcript first; only when a deciding call named a case whose
//      answer as printed does not show it decided (the AI trimmed or filtered the output) does it ask the decisions'
//      own server, as `confirm_with` in the settings says, whether that case is decided. How an answer was printed can
//      therefore never refuse a decision that was made, and printed text alone never stands in for one.
//   4. When the turn cannot be read the change is refused with the reason (never assumed decided).
//   5. Deciding never needs a file change, so a refused session can always decide and continue.
//   6. When the decisions' own server cannot keep a decision (its answer matches `when_trillion_is_down.down_answers`,
//      a 5xx, or no answer at all), checked by this hook itself, a turn that ran the method on this computer
//      (`local_method_commands`) may change files. Without that check the deciding road is the fix's own blocker: on
//      2026-10-03 Alex's store filled and every chat, including the one freeing it, was refused.
//   7. When an old transcript has no user boundary in the bounded tail, fallback may use only a successful attested
//      local-method suffix after checking every newer complete row. That suffix is evidence to check the server, not
//      permission by itself; only the independent down check above can allow the change. Compaction is never a boundary.
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.PreToolUse += { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
//     "hooks": [{ "type": "command", "command": "node <this file>" }] }
//   Codex, ~/.codex/hooks.json: hooks.PreToolUse += { "matcher": "apply_patch|exec_command|shell|exec|Bash|Edit|Write",
//     "hooks": [{ "type": "command", "command": "node <this file>", "timeoutSec": 40 }] }
//     Codex skips a new or changed hook silently until it is trusted. `codex app-server` answers hooks/list with each
//     hook's key, trustStatus and currentHash; config/value/write of hooks.state."<key>".trusted_hash = currentHash
//     trusts it (the same thing the interactive hook review does).
//
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { accountKeyOrNull } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'decide-before-building.json'), 'utf8'));

const textOf = content => (Array.isArray(content)
  ? content.map(part => (typeof part === 'string' ? part : part?.text ?? (typeof part?.content === 'string' ? part.content : ''))).join('\n')
  : typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content));
// MCP text blocks are separate values. Joining a result JSON and its appended instruction JSON corrupts both.
const answerText = content => Array.isArray(content) ? JSON.stringify({ content }) : textOf(content);

// One transcript row as events: { kind: 'asked' } for the person's own message, { kind: 'call', id, name, input }
// for a tool call and { kind: 'answer', id, text } for its result. Rows are read by shape, whichever harness wrote them.
export function eventsOf(row) {
  const events = [];
  // These are generated context or peer material, not new requests or attested tool results. Do not replay a
  // compaction's replacement history; original calls remain readable before it in the same transcript.
  if (row?.type === 'compacted' || row?.isCompactSummary === true || row?.isMeta === true || row?.origin?.kind === 'peer') return events;
  // Codex records completed nested shell calls as attested items, rather than tool_use messages.
  const completed = row?.type === 'event_msg' && row?.payload?.type === 'item_completed' ? row.payload.item : null;
  // Consultation may count a failed native read attempt. Keep that execution separate from a
  // successful command, so a failed method or printed decision cannot grant the build fallback.
  if (completed?.type === 'CommandExecution' && completed.status === 'completed'
    && Number.isInteger(completed.exit_code) && Array.isArray(completed.command)) {
    events.push({ kind: 'command_completed', id: completed.id ?? `${row.timestamp}:command`,
      command: completed.command, exit_code: completed.exit_code });
  }
  if (completed?.type === 'CommandExecution' && completed.status === 'completed' && completed.exit_code === 0 && Array.isArray(completed.command)) {
    const id = completed.id ?? `${row.timestamp}:command`;
    events.push({ kind: 'call', id, name: 'exec_command', input: { command: completed.command.at(-1) } });
    events.push({ kind: 'answer', id, text: completed.aggregated_output ?? completed.stdout ?? '' });
  }
  // Only an attested failed decision answer can prove the service could not keep it. A slow
  // answer can time out while lighter reads still work, so checking list_decisions alone misses it.
  const failedAnswer = completed?.type === 'McpToolCall' && completed.status === 'failed'
    && (completed.server === 'trillion' && completed.tool === 'answer_question'
      || completed.server === 'codex_apps' && completed.tool === 'trillion.answer_question');
  const exhausted = completed?.result?.structuredContent?.error?.code === 'resource-exhausted';
  const timedOut = /(?:MCP request timed out|timed out awaiting tools\/call after \d+s)/i.test(completed?.error?.message ?? '');
  if (failedAnswer && (exhausted || timedOut)) {
    events.push({ kind: 'decision_unavailable', code: exhausted ? 'resource-exhausted' : 'timeout' });
  }
  // Codex records nested MCP calls made inside functions.exec as completed tool items. This is the
  // attested result; the wrapper's printable output can be shortened or forged by its JavaScript.
  const item = row?.type === 'event_msg' && row?.payload?.type === 'item_completed' ? row.payload.item : null;
  const trillionTool = item?.server === 'trillion' ? item.tool : item?.server === 'codex_apps' && item.tool?.startsWith('trillion.') ? item.tool.slice('trillion.'.length) : null;
  if (item?.type === 'McpToolCall' && item.status === 'completed' && trillionTool && item.result && !item.result.isError) {
    const id = item.id ?? `${row.timestamp}:${item.tool}`;
    const structured = item.result.structuredContent;
    events.push({ kind: 'call', id, name: `mcp__trillion__${trillionTool}`, input: item.arguments ?? {} });
    events.push({ kind: 'answer', id, text: structured ? JSON.stringify(structured) : answerText(item.result.content) });
  }
  const message = row?.message ?? (row?.type === 'response_item' && row?.payload?.type === 'message' ? row.payload : null);
  if (message?.role === 'user' || message?.role === 'assistant') {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (message.role === 'assistant' && part?.type === 'tool_use') events.push({ kind: 'call', id: part.id, name: part.name, input: part.input ?? {} });
      if (message.role === 'user' && part?.type === 'tool_result') events.push({ kind: 'answer', id: part.tool_use_id, text: answerText(part.content), error: part.is_error === true });
    }
    const said = textOf(parts.length ? parts.filter(part => ['text', 'input_text'].includes(part?.type)) : message.content);
    const injected = /^\s*<(system-reminder|environment_context|user_instructions|cross-session-message)/.test(said);
    const fromPerson = row?.isSidechain !== true && row?.promptSource !== 'sdk' && row?.entrypoint !== 'sdk-cli';
    if (message.role === 'user' && fromPerson && said.trim() && !injected && !parts.some(part => part?.type === 'tool_result')) events.push({ kind: 'asked', text: said.trim().slice(0, 2000), at: row?.timestamp ?? null });
  }
  const payload = row?.type === 'response_item' ? row.payload : null;
  if (payload && payload.type !== 'message') {
    if (/_call$/.test(payload.type)) {
      let input = payload.arguments ?? payload.input ?? {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { text: input }; } }
      events.push({ kind: 'call', id: payload.call_id ?? payload.id, name: payload.name ?? payload.type, input });
    }
    if (/_output$/.test(payload.type)) events.push({ kind: 'answer', id: payload.call_id ?? payload.id, text: answerText(payload.output) });
  }
  return events;
}

// The person's last message ({ text, at } or null) and the calls and answers since it.
export function turnWithAsk(lines) {
  const events = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    events.push(...eventsOf(row));
  }
  const start = events.findLastIndex(event => event.kind === 'asked');
  return { asked: start === -1 ? null : { text: events[start].text, at: events[start].at }, turn: start === -1 ? events : events.slice(start + 1) };
}

// The calls and answers since the person's last message.
export const currentTurn = lines => turnWithAsk(lines).turn;

// Read the latest complete turn without loading a long-running session's entire JSONL file.
// A missing user boundary, oversized line, or malformed complete row fails closed.
// Adjudication may stop at an attested decision after checking every newer row;
// that suffix proves the decision follows the last request without reading it. The
// fallback reader can likewise stop at a successful local-method completion, but its
// caller must still independently establish that Trillion cannot keep the decision.
export function turnWithAskFromFile(path, read = null, { stopWhenDecided = false, stopWhenLocalMethod = false, rules = settings } = {}) {
  if (read) return turnWithAsk(read(path).split('\n').filter(Boolean));
  const fd = openSync(path, 'r');
  try {
    let at = fstatSync(fd).size;
    const size = at;
    let carry = Buffer.alloc(0);
    let tail = true;
    const reverse = [];
    const accept = bytes => {
      if (!bytes.length) return null;
      const events = eventsOf(JSON.parse(bytes.toString('utf8')));
      const ask = events.findLastIndex(event => event.kind === 'asked');
      if (ask !== -1) {
        const latest = events[ask];
        return { asked: { text: latest.text, at: latest.at }, turn: [...events.slice(ask + 1), ...reverse.reverse().flat()] };
      }
      if (events.length) reverse.push(events);
      // Decision adjudication needs only a matched attested decision with no
      // newer person request. Every newer complete row has already been read
      // here. Older screenshots and compactions cannot change that ordering.
      // Full-turn consumers still read through the actual person boundary.
      if (stopWhenDecided && events.some(event => decidingOperation(event, rules))) {
        const turn = reverse.toReversed().flat();
        if (turnDecided(turn, rules)) return { asked: null, turn };
      }
      // A fallback suffix may establish only that the local method completed in the
      // current turn. It is never a user boundary or an authorization result. The
      // decision owner still has to independently return down:true before allowing a write.
      if (stopWhenLocalMethod && events.some(event => event.kind === 'command_completed'
        || event.kind === 'call' && event.name === 'Bash')) {
        const turn = reverse.toReversed().flat();
        if (successfulLocalMethod(turn, rules.when_trillion_is_down, rules)) return { asked: null, turn };
      }
      return null;
    };
    while (at > 0) {
      const length = Math.min(64 * 1024, at);
      at -= length;
      if (size - at > 128 * 1024 * 1024) throw new Error('No user boundary in bounded transcript tail.');
      const chunk = Buffer.allocUnsafe(length);
      if (readSync(fd, chunk, 0, length, at) !== length) throw new Error('Transcript changed while reading.');
      const block = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let right = block.length;
      for (let i = block.length - 1; i >= 0; i--) {
        if (block[i] !== 10) continue;
        let found;
        if (tail) {
          tail = false;
          // A final row without a newline counts only if it is already valid JSON.
          // A partially written row has not happened yet and is ignored.
          try { found = accept(block.subarray(i + 1, right)); } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        } else {
          found = accept(block.subarray(i + 1, right));
        }
        if (found) return found;
        right = i;
      }
      carry = Buffer.from(block.subarray(0, right));
      if (carry.length > 64 * 1024 * 1024) throw new Error('Transcript line is too large to verify.');
    }
    return accept(carry) ?? { asked: null, turn: reverse.reverse().flat() };
  } finally { closeSync(fd); }
}

const commandOf = input => [input?.command, input?.cmd, input?.text].flat().filter(item => typeof item === 'string').join(' ');
// A deciding tool is named exactly, or as a server's tool (mcp__trillion__decide, trillion.decide, and Codex's app
// connector's mcp__codex_apps__trillion_export_decision).
const namesADecidingTool = (name, rules) => rules.deciding_tools.some(tool => name === tool
  || ([`_${tool}`, `.${tool}`, `/${tool}`].some(end => name.endsWith(end)) && rules.deciding_servers.some(server => name.includes(server))));
// A case id is present even while the case is at its first question. The engine's JSON result carries the actual
// decision and decided_at; the markdown export has an explicit decided status and Decision section.
// A harness that finds an answer too long to show saves it to a file of its own and answers with where
// (spilled_answers in the settings): that file is the answer, read only from the harness's own folder.
const spilledAnswer = (text, rules, read) => {
  for (const spill of rules.spilled_answers ?? []) {
    const path = new RegExp(spill.pattern).exec(text)?.[1];
    if (!path) continue;
    const full = resolve(expand(path));
    const inside = spill.folders.some(folder => full.startsWith(`${resolve(expand(folder))}/`)) && full.includes(`/${spill.subfolder}/`);
    if (!inside) continue;
    try { return read(full); } catch { return null; }
  }
  return null;
};
const decidedAnswer = (text, name, rules = settings, read = path => readFileSync(path, 'utf8')) => {
  const terminalTool = /(?:^|[_./])(decide|export_decision)$/.exec(name)?.[1];
  if (!terminalTool) return false;
  const spilled = spilledAnswer(text, rules, read);
  if (spilled != null) return decidedAnswer(spilled, name, { ...rules, spilled_answers: [] }, read);
  if (terminalTool === 'export_decision' && /^Status: Decided(?:\b|:)/m.test(text) && /^## Decision\s*$/m.test(text)) return true;
  const candidates = [text, text.split(/(?:^|\n)Output:\s*\n/).at(-1)];
  for (const candidate of candidates) {
    let record;
    try { record = JSON.parse(candidate); } catch { continue; }
    if (record?.isError === true || record?.error) continue;
    // The saved-key caller prints the whole JSON-RPC answer: the tool's result sits under `result`.
    if (record?.jsonrpc && record.result && typeof record.result === 'object') record = record.result;
    if (record?.isError === true || record?.error) continue;
    const content = Array.isArray(record) ? record : record?.content;
    if (Array.isArray(content)) {
      if (content.some(part => ['text', 'input_text'].includes(part?.type) && decidedAnswer(part.text ?? '', name, rules, read))) return true;
    }
    if (typeof record?.text === 'string' && decidedAnswer(record.text, name, rules, read)) return true;
    const decision = record?.decision;
    // A decide sent again with the same words answers already_decided with the recorded decision: the case is decided.
    if ((terminalTool === 'decide' || record?.decided_at || record?.already_decided === true) && decision?.option_id && decision?.reason && decision?.next_action && decision?.success_measure) return true;
  }
  return false;
};

// The case a deciding call named: `case_id` in a tool's input, or in the JSON a shell command hands the saved-key caller.
const caseNamed = (event) => {
  if (typeof event.input?.case_id === 'string') return event.input.case_id;
  return /"case_id"\s*:\s*"([^"]+)"/.exec(commandOf(event.input))?.[1] ?? null;
};

/** The cases deciding calls in this turn named, whose printed answers did not show them decided. */
export function casesToConfirm(turn, rules = settings) {
  const named = [];
  for (const event of turn) {
    if (event.kind !== 'call') continue;
    const deciding = rules.deciding_tools.some(tool => namesADecidingTool(event.name, { ...rules, deciding_tools: [tool] }))
      || ((rules.shell_tools.includes(event.name) || /exec|shell|Bash/.test(event.name))
        && (rules.deciding_commands ?? []).some(pattern => new RegExp(pattern).test(commandOf(event.input))));
    const id = deciding ? caseNamed(event) : null;
    if (id && !named.includes(id)) named.push(id);
  }
  return named;
}

/** One MCP session with the decisions' own server, as `confirm` says: the key is read by name from the system keychain
 *  and kept in memory only. → null without a url or key, else `tool(name, args)` → { status, text } (text is the
 *  tool's printed answer, or the raw body when the server answered with no tool result); a failure to reach the
 *  server throws. Every caller below talks to the server through this one road. */
export function trillionCaller(confirm = settings.confirm_with, { request = fetch, keyOf = readKey, key = null, signal = null } = {}) {
  if (!confirm?.url) return null;
  const secret = key ?? keyOf(confirm.keychain_item);
  if (!secret) return null;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` };
  let session = null;
  let id = 0;
  const post = async body => {
    signal?.throwIfAborted();
    const requestSignal = AbortSignal.timeout(confirm.timeout_ms ?? 8000);
    const response = await request(confirm.url, { method: 'POST', headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal });
    const text = (await response.text()).trim();
    session = response.headers.get('mcp-session-id') ?? session;
    let message = null;
    try { message = !text ? null : text.startsWith('{') ? JSON.parse(text) : text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).pop(); } catch { message = null; }
    return { status: response.status, text, message };
  };
  let opened = null;
  const open = async () => {
    const first = await post({ jsonrpc: '2.0', id: (id += 1), method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'decide-before-building', version: '1' } } });
    if (first.status < 500) await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return first;
  };
  const tool = async (name, args = {}) => {
    opened ??= open();
    const first = await opened;
    if (first.status >= 500) return { status: first.status, text: first.text };
    const answer = await post({ jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } });
    const parts = answer.message?.result?.content;
    return { status: answer.status, text: Array.isArray(parts) ? parts.map(part => part?.text ?? '').join('\n') : answer.text, error: answer.message?.result?.isError === true };
  };
  tool.opened = async () => { opened ??= open(); return opened; };
  return tool;
}

/** Whether an export answer shows the case decided. */
export const exportShowsDecided = text => /^Status: Decided(?:\b|:)/m.test(text) && /^## Decision\s*$/m.test(text);

/** Whether a server answer is one of the down answers (the store full, busy, broken). */
export const downAnswer = (text, down = settings.when_trillion_is_down) => (down?.down_answers ?? []).some(phrase => String(text).toLowerCase().includes(phrase.toLowerCase()));

/** Asks the decisions' own server whether a case is decided. Any failure answers false, so a refusal stands. */
export async function confirmDecided(caseId, confirm = settings.confirm_with, { request = fetch, keyOf = readKey, caller = null } = {}) {
  if (!caseId) return false;
  try {
    const tool = caller ?? trillionCaller(confirm, { request, keyOf });
    if (!tool) return false;
    return exportShowsDecided((await tool('export_decision', { case_id: caseId })).text);
  } catch { return false; }
}

/** Whether the decisions' own server cannot keep a decision right now, asked with the same key and url as confirmDecided.
 *  A refused key or a decided/undecided answer is not down; only a server failure, a matching down answer or no answer is. */
export async function trillionDown(confirm = settings.confirm_with, down = settings.when_trillion_is_down, { request = fetch, keyOf = readKey, key = null, caller = null } = {}) {
  if (!confirm?.url || !down) return false;
  let tool;
  try { tool = caller ?? trillionCaller(confirm, { request, keyOf, key }); } catch { return true; }
  if (!tool) return false;
  try {
    const opened = await tool.opened();
    if (opened.status >= 500 || downAnswer(opened.text, down)) return true;
    const listed = await tool('list_decisions', { limit: 1 });
    if (listed.status >= 500 || downAnswer(listed.text, down)) return true;
    // A read may work while the store refuses writes. This nonexistent case checks the deciding road without
    // creating or changing a decision, preserving the installed write-availability check. The service may still
    // capture execution history for this call.
    const deciding = await tool('decide', { case_id: 'source:no-such-case-down-probe', option_id: 'none' });
    return deciding.status >= 500 || downAnswer(deciding.text, down);
  } catch { return true; }
}

/** One connection and one overall budget for all case confirmations and the local-method fallback. Expiring that
 *  overall budget is a refusal, never proof that the server is down. Individual unanswered requests retain the
 *  existing server-down semantics. The outer harness gets time to read the transcript and print its final answer. */
export async function decisionServerState(turn, rules = settings, { request = fetch, keyOf = readKey } = {}) {
  const none = { decided: false, down: false, timed_out: false };
  const controller = new AbortController();
  const budget = rules.confirm_with?.total_timeout_ms ?? 30000;
  const deadline = performance.now() + budget;
  const timeout = setTimeout(() => controller.abort(), budget);
  const expired = () => {
    if (performance.now() >= deadline) controller.abort();
    return controller.signal.aborted;
  };
  const timedOut = () => ({ ...none, timed_out: true });
  try {
    const cases = casesToConfirm(turn, rules);
    const local = turnRanLocalMethod(turn, rules.when_trillion_is_down, rules);
    if (!cases.length && !local) return none;
    let caller;
    try { caller = trillionCaller(rules.confirm_with, { request, keyOf, signal: controller.signal }); }
    catch { return local ? { ...none, down: true } : none; }
    if (!caller) return { ...none, down: local && turn.some(item => item.kind === 'decision_unavailable') };
    for (const caseId of cases) {
      if (expired()) return timedOut();
      const decided = await confirmDecided(caseId, rules.confirm_with, { caller, request, keyOf });
      if (expired()) return timedOut();
      if (decided) return { ...none, decided: true };
    }
    if (expired()) return timedOut();
    if (!local) return none;
    if (turn.some(item => item.kind === 'decision_unavailable')) return { ...none, down: true };
    const down = await trillionDown(rules.confirm_with, rules.when_trillion_is_down, { caller, request, keyOf });
    return expired() ? timedOut() : { ...none, down };
  } finally { clearTimeout(timeout); }
}

/** Whether the turn ran the method on this computer, as `local_method_commands` names it. */
export function turnRanLocalMethod(turn, down = settings.when_trillion_is_down, rules = settings) {
  const patterns = (down?.local_method_commands ?? []).map(pattern => new RegExp(pattern));
  return patterns.length > 0 && turn.some(event => event.kind === 'call'
    && (rules.shell_tools.includes(event.name) || /exec|shell|Bash/.test(event.name))
    && patterns.some(pattern => pattern.test(commandOf(event.input))));
}

/** A suffix candidate must contain a successful shell result or a Codex-attested zero-exit command completion. */
function successfulLocalMethod(turn, down = settings.when_trillion_is_down, rules = settings) {
  const patterns = (down?.local_method_commands ?? []).map(pattern => new RegExp(pattern));
  if (!patterns.length) return false;
  const matches = command => patterns.some(pattern => pattern.test(command));
  const answers = new Map(turn.filter(event => event.kind === 'answer').map(event => [event.id, event]));
  return turn.some(event => {
    if (event.kind === 'command_completed') {
      return event.exit_code === 0 && Array.isArray(event.command) && matches(event.command.join(' '));
    }
    // Claude's Bash tool attests failure with is_error. Codex requires its native
    // CommandExecution completion above; wrapper output alone cannot prove exit zero.
    if (event.kind !== 'call' || event.name !== 'Bash' || !rules.shell_tools.includes(event.name)
      || !matches(commandOf(event.input))) return false;
    const answer = answers.get(event.id);
    return Boolean(answer && !answer.error);
  });
}

/** Read the ordinary turn first; only an unreadable long turn gets the narrow method suffix fallback. */
export function turnForDecisionFallback(path) {
  try { return turnWithAskFromFile(path).turn; } catch {}
  try { return turnWithAskFromFile(path, null, { stopWhenLocalMethod: true }).turn; } catch { return []; }
}

function readKey(item) {
  return accountKeyOrNull({ item, timeout: 3000 });
}

/** Whether the turn includes a terminal Trillion decision answer: a signed-in deciding tool, Codex code mode's attested
 *  nested MCP completion, or the saved-key caller named in deciding_commands run with decide or export_decision
 *  (a chat whose sign-in dropped still decides through its own key, so it is never locked out of its work). */
function decidingOperation(event, rules) {
  if (event.kind !== 'call') return undefined;
  return rules.deciding_tools.find(tool => namesADecidingTool(event.name, { ...rules, deciding_tools: [tool] }))
    ?? (rules.shell_tools.includes(event.name) || /exec|shell|Bash/.test(event.name)
      ? (rules.deciding_commands ?? []).map(pattern => new RegExp(pattern).exec(commandOf(event.input))?.[1]).find(Boolean)
      : undefined);
}

export function turnDecided(turn, rules = settings, read = path => readFileSync(path, 'utf8')) {
  const answers = new Map(turn.filter(event => event.kind === 'answer').map(event => [event.id, event]));
  return turn.some(event => {
    const operation = decidingOperation(event, rules);
    const answer = answers.get(event.id);
    return Boolean(operation) && !answer?.error && decidedAnswer(answer?.text ?? '', operation, rules, read);
  });
}

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const insideGitRepository = path => {
  for (let at = dirname(path); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
};

/** The lasting files this call would change, or null when it changes none. A patch names its own files. */
export function lastingChange(event, rules = settings) {
  const { tool_name: name, tool_input: input = {}, cwd = process.cwd() } = event;
  if (rules.shell_tools.includes(name)) {
    const command = commandOf(input);
    // A row is a pattern, or { pattern, what } where `what` is the change reported in the refusal.
    const hit = rules.shell_changes.find(row => new RegExp(row?.pattern ?? row).test(command));
    return hit ? [hit?.what ?? 'a commit'] : null;
  }
  if (!rules.file_tools.includes(name)) return null;
  const named = rules.path_fields.map(field => input[field]).filter(item => typeof item === 'string');
  const patched = [...commandOf(input).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1].trim());
  const paths = [...named, ...patched].map(path => (isAbsolute(expand(path)) ? expand(path) : resolve(cwd, path)));
  const free = rules.free_folders.map(folder => resolve(expand(folder)));
  const lasting = paths.filter(path => !free.some(folder => path === folder || path.startsWith(`${folder}/`)) && insideGitRepository(path));
  return lasting.length ? lasting : (paths.length ? null : ['an unnamed file']);
}

/** Codex events can leave out the transcript path and give a session id. */
function codexTranscript(sessionId) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  let best = null;
  const walk = (folder, depth) => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(sessionId)) {
        const at = statSync(path).mtimeMs;
        if (!best || at > best.at) best = { path, at };
      }
    }
  };
  walk(root, 0);
  return best?.path ?? null;
}

/** A subagent's calls are in its own transcript beside its session's (`<session>/subagents/agent-<agent_id>.jsonl`),
 *  while the event's transcript_path names the session that started it. */
function subagentTranscript(event) {
  if (typeof event.agent_transcript_path === 'string') return event.agent_transcript_path;
  const id = event.agent_id ?? event.agentId;
  const session = event.transcript_path ?? event.transcriptPath;
  if (typeof id !== 'string' || typeof session !== 'string') return null;
  const path = join(session.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`);
  return existsSync(path) ? path : null;
}

/** The transcript a hook event belongs to (a subagent's own, the session's, or a Codex rollout found by session id). */
export const transcriptOf = event => subagentTranscript(event) ?? event.transcript_path ?? event.transcriptPath ?? codexTranscript(event.session_id ?? process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID);

/** The answer for one pre-tool event: null to allow, or the refusal reason. */
export function judge(event, { read = null, rules = settings } = {}) {
  const changes = lastingChange(event, rules);
  if (!changes) return null;
  const path = subagentTranscript(event) ?? event.transcript_path ?? event.transcriptPath ?? codexTranscript(event.session_id ?? process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID);
  let turn;
  try { ({ turn } = turnWithAskFromFile(path, read, { stopWhenDecided: true, rules })); } catch { return `${rules.refusal} (This turn could not be read${path ? ` from ${path}` : ''}, so no decision could be found.)`; }
  return turnDecided(turn, rules, read ?? (at => readFileSync(at, 'utf8'))) ? null : `${rules.refusal} Refused: ${changes.slice(0, 3).join(', ')}.`;
}

// Retired universal hook entry. Contextual source reads and optional decision helpers remain available.
