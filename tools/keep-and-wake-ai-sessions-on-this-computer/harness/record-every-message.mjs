#!/usr/bin/env node
// harness/record-every-message.mjs
//
// Purpose
//   A prompt and turn-end hook for AI coding harnesses. Prompt submission sends the person's words into Trillion
//   before the AI finishes; Stop reads the transcript from where it last stopped and retries anything not yet kept.
//   Both paths take every message the person wrote and every reply the AI wrote since then, word for word, and keep them in the person's
//   Trillion (person messages through /mcp/api/inbound, AI replies through /mcp/api/messages) with their original times. Recording no longer
//   depends on the AI choosing to call a tool.
//
// Non-negotiable invariants
//   1. Nothing here names a harness: how a harness is recognized, where its transcripts live, which rows are the
//      person's words or the AI's replies, and which text a harness injects that nobody said are DATA in
//      record-every-message.json beside this file.
//   2. Text is sent exactly as written. A part a harness injected (a reminder, the environment, an instruction file)
//      is left out whole; nothing is trimmed, rewritten or summarized.
//   3. Every message carries its original time, so a resend is the message already kept (the store dedupes it).
//   4. The cursor (~/.trillion/record-every-message/<session>.json) moves only past messages Trillion accepted, and it
//      is a byte offset, so each turn reads only what was written since the last one.
//   5. A prompt sent before its transcript row uses a kept time mark. Stop reuses that time, so a timed-out send can be
//      retried without making a second message. It never blocks the turn beyond its time box, prints nothing and exits 0.
//   6. The account key is read from the macOS Keychain by name at send time, held in memory and put only in the
//      Authorization header.
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.Stop runs node <this file>; hooks.UserPromptSubmit runs
//     node <this file> --harness claude-code. Both are async with a 10-second hook timeout.
//   Codex, ~/.codex/hooks.json: hooks.Stop runs node <this file>; hooks.UserPromptSubmit runs
//     node <this file> --harness codex. Codex runs a hooks.json entry only once its hash is trusted
//     in ~/.codex/config.toml ([hooks.state."<hooks.json>:stop:<group>:<index>"] trusted_hash), and the hash to trust is
//     the currentHash Codex's own app server reports for that key (method hooks/list).
//   Backfill one transcript by hand: node <this file> --transcript <path.jsonl or path.json>
//   Every chat behind its cursor, of every harness (a turn still running for hours, a hook that never ran, and harnesses
//     with no hook of their own, rows with sweep: true such as Gemini CLI and Hermes, whose sessions are whole JSON
//     documents): node <this file> --sweep. It runs from every harness's Stop hook and every `sweep.every_seconds` from
//     the wake-sessions helper (wake-handlers/keep-every-message.mjs), so a message typed during a long turn is kept
//     within minutes and a missed hook heals itself. One sweep runs on the computer at a time (`sweep.lock` in the cursor
//     folder); a sweep started while another runs ends at once.
//   A live read takes at most transcript_read_bytes from the cursor (a row up to transcript_row_bytes), never the rest of the file;
//   what is left is read on the next pass. One backlog drain (--drain) runs on the computer at a time (`drain.lock`) and ends at drain_most_ms.
//   AI replies go to Trillion up to `batch_size` a request; a person's message, or one carrying files, goes alone.
//
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import v8 from 'node:v8';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { keepHookRunOnExit } from './hook-run-receipt.mjs';
import { queueSourceReturnCandidates } from './source-return-pending.mjs';
import { requireAccountKey } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'record-every-message.json'), 'utf8'));

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
export const at = (row, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), row);

export function startSourceReturnCheck(candidates, { queue = queueSourceReturnCandidates, spawnChild = spawn } = {}) {
  if (!candidates?.length) return 0;
  // Persist in the Stop process: the detached child may die before reading stdin.
  const queued = queue(candidates);
  if (!queued) return 0;
  try {
    const child = spawnChild(process.execPath, [join(HERE, 'request-source-return-check.mjs'), '--replay'], {
      detached: true, stdio: 'ignore',
    });
    child.once('error', () => {}); // The queued candidates remain for the session helper to replay.
    child.unref();
  } catch { /* The queued candidates remain for the session helper to replay. */ }
  return queued;
}

/** Whether one row meets every condition: { path, is }, { path, is_not }, { path, one_of } or { path, present }. */
export function meets(row, conditions = []) {
  return conditions.every(({ path, is, is_not: isNot, one_of: oneOf, present }) => {
    const value = at(row, path);
    if (present !== undefined) return (value !== undefined && value !== null) === present;
    if (oneOf !== undefined) return oneOf.includes(value);
    if (is !== undefined) return value === is;
    if (isNot !== undefined) return value !== isNot;
    return true;
  });
}

/** The harness that wrote these rows, or null. */
export function harnessOf(rows, rules = settings) {
  return rules.harnesses.find(harness => rows.some(row => meets(row, harness.recognized_by))) ?? null;
}

/** Whether a text is one a harness or another AI put into the chat (record-every-message.json injected_text). */
export const injectedText = (text, rules = settings) => rules.injected_text.some(row => new RegExp(row.pattern).test(text));
/** The speaker injected text is kept under (its row's kept_as: 'peer', 'generated context'), or null when nobody injected it. */
export const injectedAs = (text, rules = settings) => rules.injected_text.find(row => new RegExp(row.pattern).test(text))?.kept_as ?? null;

/** The words in a person's row that another AI session relayed into the chat (injected_text kept_as peer): kept as that
 *  peer's message, never as the person's and never dropped. '' when there are none. */
export function peerWordsOf(value, { part_types: types }, rules = settings) {
  const parts = typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.filter(part => types.includes(part?.type ?? 'text') && typeof part.text === 'string').map(part => part.text)
      : [];
  return parts.filter(text => text.trim() && injectedAs(text, rules) === 'peer').join('\n');
}

/** The words a row's text field holds, without the parts a harness injected; '' when none are left. */
export function wordsOf(value, { part_types: types, strip_generated_request_prefix: stripGeneratedRequestPrefix = false }, rules = settings) {
  const parts = typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.filter(part => types.includes(part?.type ?? 'text') && typeof part.text === 'string').map(part => part.text)
      : [];
  return parts.map(text => {
    if (stripGeneratedRequestPrefix && /^\s*(?:<in-app-browser-context\b|# Files (?:pasted|mentioned) by the user:)/.test(text)) {
      const request = text.indexOf('## My request:');
      text = request < 0 ? '' : text.slice(request + '## My request:'.length).replace(/^\s+/, '');
    }
    return text;
  }).filter(text => text.trim() && !injectedText(text, rules)).join('\n');
}

/** Binary parts belonging to one declared message row; plain strings, generated parts and path-only temp files stay out. */
export function attachmentSourcesOf(row, rule, rules = settings) {
  const spec = rule.attachments;
  if (!spec) return [];
  let parts = at(row, spec.path);
  if (!Array.isArray(parts)) return [];
  if (spec.content_kinds_path) {
    const kinds = at(row, spec.content_kinds_path);
    if (Array.isArray(kinds) && kinds.length === parts.length)
      parts = parts.filter((_, index) => typeof kinds[index] === 'string' && kinds[index].startsWith(spec.human_kind_prefix ?? 'user.'));
  }
  const sources = [];
  for (const part of parts) {
    if (!part || !spec.part_types.includes(part.type)) continue;
    let data = spec.data_paths.map(path => at(part, path)).find(value => typeof value === 'string' && value);
    let media_type = spec.media_type_paths.map(path => at(part, path)).find(value => typeof value === 'string' && value);
    const source = part.source;
    if (source?.type === 'base64' && typeof source.data === 'string') {
      data ??= source.data;
      media_type ??= source.media_type;
    }
    if (typeof data !== 'string') continue;
    const dataUrl = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (dataUrl) { media_type ??= dataUrl[1]; data = dataUrl[2]; }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
    const name = spec.name_paths.map(path => at(part, path)).find(value => typeof value === 'string' && value.trim());
    sources.push({ data, media_type: typeof media_type === 'string' ? media_type : 'application/octet-stream', ...(name ? { name } : {}) });
  }
  return sources;
}

/** The messages in a run of rows, in order, and the harness context (a model named once for many rows) after them.
 *  `marks[i]` is where message i's row ends in `ends` (byte offsets, when given) and the context at that row. */
export function messagesOf(rows, harness, { sessionId, context = {}, ends = [], personSpeaks = true } = {}, rules = settings) {
  const found = [];
  const marks = [];
  const deferred = [];
  const known = { ...context };
  for (const [index, row] of rows.entries()) {
    for (const carried of harness.context) {
      const value = meets(row, carried.when) ? at(row, carried.path) : undefined;
      if (typeof value === 'string' && value) known[carried.name] = value;
    }
    const rule = harness.messages.find(candidate => meets(row, candidate.when));
    if (!rule || (rule.speaker === 'person' && !personSpeaks)) continue;
    // A row another row speaks for (`superseded_by`): a later row within within_ms, meeting one of its `rows` (each
    // { when, text_path }), that carries these same words. A queued message becomes such a row once it is taken (the
    // turn's own user row, or a queued_command row), and that row says who sent it: the person, another AI or a
    // program. With await_source, an unresolved queue is retained in the cursor until sender evidence arrives.
    if (rule.superseded_by) {
      const words = String(at(row, rule.text.path) ?? '').trim();
      const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
      const start = Date.parse(at(row, harness.time_path));
      let spoken = false;
      for (let next = index + 1; words && !spoken && next < rows.length; next += 1) {
        const later = rows[next];
        const gap = Date.parse(at(later, harness.time_path)) - start;
        if (!rule.await_source && gap > 2 * rule.superseded_by.within_ms) break; // rows are written in time order, give or take a turn's own clock
        spoken = (rule.await_source || Math.abs(gap) <= rule.superseded_by.within_ms)
          && rule.superseded_by.rows.some(({ when, text_path: path }) => meets(later, when) && textOf(at(later, path)).includes(words));
      }
      if (spoken) continue;
    }
    let content = at(row, rule.text.path);
    const kinds = rule.text.content_kinds_path ? at(row, rule.text.content_kinds_path) : null;
    if (Array.isArray(kinds)) {
      const prefix = rule.text.human_kind_prefix;
      content = Array.isArray(content) && kinds.length === content.length
        ? content.filter((_, position) => typeof kinds[position] === 'string' && kinds[position].startsWith(prefix))
        : typeof content === 'string' && kinds.length === 1 && kinds[0]?.startsWith(prefix) ? content : [];
    }
    const text = wordsOf(content, rule.text, rules);
    const attachment_sources = rule.speaker === 'person' ? attachmentSourcesOf(row, rule, rules) : [];
    const time = at(row, harness.time_path) ?? (harness.time_fallback_path ? at(row, harness.time_fallback_path) : undefined);
    // Words another AI session relayed into the person's row ("From <someone>'s Claude session: ..."): kept as the
    // peer's own message at the row's time, so the turn is recorded as who sent it rather than lost.
    const relayed = rule.speaker === 'person' && !rule.await_source ? peerWordsOf(content, rule.text, rules) : '';
    if (relayed && typeof time === 'string' && !Number.isNaN(Date.parse(time))) {
      const sourceRef = harness.source_ref_paths?.map(path => at(row, path)).find(value => typeof value === 'string' && value)
      ?? (Number.isSafeInteger(ends[index]) ? `transcript-row:${ends[index]}` : undefined);
      found.push({ conversation_id: `${harness.id}:${sessionId}`, app: harness.app, speaker: 'peer', text: relayed, at: new Date(time).toISOString(),
        ...(sourceRef ? { source_ref: `${sourceRef}:peer` } : {}) });
      marks.push({ offset: ends[index], context: { ...known } });
    }
    if ((!text && !attachment_sources.length) || typeof time !== 'string' || Number.isNaN(Date.parse(time))) continue;
    // Unknown origin stays recoverable on disk. Time or the absence of a later row is never evidence of a person.
    if (rule.await_source) { deferred.push({ row, offset: ends[index] }); continue; }
    const model = rule.model?.context ? known[rule.model.context] : rule.model?.path ? at(row, rule.model.path) : undefined;
    const sourceRef = harness.source_ref_paths?.map(path => at(row, path)).find(value => typeof value === 'string' && value)
      ?? (Number.isSafeInteger(ends[index]) ? `transcript-row:${ends[index]}` : undefined);
    // Who the row says wrote it, kept with the person's words so the store can refuse a decision for words nobody typed.
    const origin = rule.origin_path ? at(row, rule.origin_path) : undefined;
    found.push({
      conversation_id: `${harness.id}:${sessionId}`, app: harness.app, speaker: rule.speaker, text, at: new Date(time).toISOString(),
      ...(rule.speaker === 'person' && typeof origin === 'string' && origin ? { origin } : {}),
      ...(rule.speaker === 'ai' && meets(row, harness.final_reply_when) ? { final_reply: true } : {}),
      ...(sourceRef ? { source_ref: sourceRef } : {}),
      ...(attachment_sources.length ? { attachment_sources } : {}),
      ...(typeof model === 'string' && model ? { model } : {}),
    });
    marks.push({ offset: ends[index], context: { ...known } });
  }
  return { messages: found, marks, context: known, deferred };
}

/** Supported native tool rows become bounded receipts, never message text or copied tool payloads. These hooks
 * observe a transcript after the fact; they do not claim to intercept an unsupported host before dispatch. */
export function executionsOf(rows, harness, { sessionId, ends = [], context = {} } = {}, rules = settings) {
  const executions = [], marks = [];
  const known = { ...context };
  const referenceRules = rules.execution_references;
  const identityPatterns = (referenceRules?.identity_patterns ?? []).map(pattern => new RegExp(pattern));
  const scalar = value => {
    if (!['string', 'number'].includes(typeof value)) return null;
    if (String(value).length > 8192) throw new Error('Execution metadata exceeds the 8192 character capture limit; no identifier was truncated and the transcript cursor was not advanced.');
    return String(value);
  };
  // Arguments can be an object or JSON-encoded arguments. Their `content` and `structuredContent` fields are
  // ordinary input data, not transport envelopes: decoding them would turn a quoted body into false metadata.
  const inputObject = value => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  const unwrap = (value, depth = 0) => {
    if (depth > 4) return null;
    if (typeof value === 'string') { try { return unwrap(JSON.parse(value), depth + 1); } catch { return null; } }
    if (Array.isArray(value)) {
      const text = value.find(part => part?.type === 'text' && typeof part.text === 'string')?.text;
      return text ? unwrap(text, depth + 1) : null;
    }
    if (value?.structuredContent) return unwrap(value.structuredContent, depth + 1);
    if (Array.isArray(value?.content) && Object.keys(value).every(key => ['content', 'isError', 'structuredContent', '_meta'].includes(key))) return unwrap(value.content, depth + 1);
    return value;
  };
  const referencesOf = (input, output) => {
    const references = [], seen = new Set();
    for (const [side, value] of [['input', input], ['result', output]]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const field of referenceRules?.fields ?? []) {
        const selected = at(value, field.path);
        const members = field.each ? Array.isArray(selected) ? selected : [] : [selected];
        if (members.length > referenceRules.max_references) throw new Error('Execution reference candidates exceed the capture limit; they were not truncated.');
        for (const [index, member] of members.entries()) {
          const candidate = field.ref_path ? at(member, field.ref_path) : member;
          if (typeof candidate !== 'string' || !identityPatterns.some(pattern => pattern.test(candidate))) continue;
          const ref = scalar(candidate);
          const declaredRole = field.role_path ? at(member, field.role_path) : null;
          const role = declaredRole ?? (side === 'result' ? 'output' : 'input');
          if (typeof role !== 'string' || !role || role.length > 80 || /[\u0000-\u001f]/.test(role)) throw new Error('Execution reference role must be bounded text.');
          const path = [side, ...field.path, ...(field.each ? [index] : []), ...(field.ref_path ?? [])];
          if (path.length > 32 || path.some(part => typeof part === 'string' && part.length > 512)) throw new Error('Execution reference path exceeds the capture limit.');
          const entry = { ref, role, basis: 'claimed', path, ...(field.each ? { ordinal: index } : {}) };
          const key = JSON.stringify(entry);
          if (seen.has(key)) continue;
          seen.add(key); references.push(entry);
          if (references.length > referenceRules.max_references) throw new Error('Execution references exceed the capture limit; they were not truncated.');
        }
      }
    }
    if (new TextEncoder().encode(JSON.stringify(references)).byteLength > (referenceRules?.max_bytes ?? 0) && references.length) throw new Error('Execution references exceed the byte capture limit; they were not truncated.');
    return references;
  };
  for (const [index, row] of rows.entries()) {
    for (const carried of harness.context ?? []) {
      const value = meets(row, carried.when) ? at(row, carried.path) : null;
      if (typeof value === 'string' && value) known[carried.name] = value;
    }
    for (const rule of harness.executions ?? []) {
      if (!meets(row, rule.when)) continue;
      const parts = rule.parts_path ? at(row, rule.parts_path) : [at(row, rule.part_path ?? [])];
      for (const part of Array.isArray(parts) ? parts : []) {
        if (!meets(part, rule.part_when)) continue;
        const id = scalar(at(part, rule.call_id_path));
        if (!id) continue;
        const time = at(row, harness.time_path) ?? (harness.time_fallback_path ? at(row, harness.time_fallback_path) : null);
        const input = (rule.input_paths ?? []).map(path => inputObject(at(part, path))).find(Boolean) ?? null;
        const output = rule.result_path ? unwrap(at(part, rule.result_path)) : null;
        const references = referencesOf(input, output);
        const observation = Object.fromEntries(Object.entries(rules.execution_result_fields ?? {}).flatMap(([field, paths]) => {
          const value = paths.map(path => scalar(at(output, path))).find(Boolean);
          return value ? [[field, value]] : [];
        }));
        const source_ref = harness.source_ref_paths?.map(path => scalar(at(row, path))).find(Boolean);
        const operation = rule.operation_path ? scalar(at(part, rule.operation_path)) : null;
        executions.push({ call_id: bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([harness.id, sessionId, id])))),
          ...(operation ? { operation } : {}), capture_kind: 'host_transcript', origin: 'unknown',
          event_phase: rule.failed_path && at(part, rule.failed_path) === true ? 'failed' : rule.phase,
          ...(typeof time === 'string' && Number.isFinite(Date.parse(time)) ? { captured_at: new Date(time).toISOString() } : {}),
          claimed: { app: harness.app, conversation_id: `${harness.id}:${sessionId}`, tool_call_id: id,
            ...(source_ref ? { source_ref } : {}), ...(known.model ? { model: known.model } : {}) },
          ...(Object.keys(observation).length ? { observation } : {}), references });
        marks.push({ offset: ends[index], context: { ...known } });
      }
    }
  }
  return { executions, marks, context: known };
}

export async function sendExecutionToTrillion(value, { rules = settings, deadline, key } = {}) {
  const response = await fetch(`${rules.origin.replace(/\/$/, '')}${rules.executions_path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => null);
  return result?.call_id === value.call_id && typeof result?.execution_ref === 'string';
}

/** A transcript kept as one JSON document (a harness row with `document`): its rows from `offset` (a row count) on,
 *  each wrapped as { row, document } so rules can read the row and the document's own fields. Null when no harness
 *  row declares a document this file matches. */
export function documentRowsFrom(path, offset, rules = settings) {
  let document;
  try { document = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  for (const harness of rules.harnesses) {
    if (!harness.document) continue;
    const list = at(document, harness.document.rows_path);
    if (!Array.isArray(list)) continue;
    const wrapped = list.map(row => ({ row, document }));
    if (!wrapped.some(row => meets(row, harness.recognized_by)) && !(list.length === 0 && meets({ document }, harness.recognized_by))) continue;
    const start = offset > wrapped.length ? 0 : offset;
    return { rows: wrapped.slice(start), ends: wrapped.slice(start).map((_, index) => start + index + 1), offset: wrapped.length, harness };
  }
  return null;
}

let readBuffer = Buffer.alloc(0);

// A collection after each pass of a backlog drain: a long drain makes garbage far faster than the engine, on a computer with
// memory to spare, finds a reason to collect it (520 MB of transcript left a drain at 230 MB, 2026-10-22).
let collect = null;
export const collectGarbage = () => {
  try {
    if (!collect) { v8.setFlagsFromString('--expose-gc'); collect = vm.runInNewContext('gc'); }
    collect();
  } catch { collect = () => {}; }
};

/** Complete rows written from `offset` on, and the offset just past the last complete one. */
export function rowsFrom(path, offset, rules = settings) {
  if (path.endsWith('.json')) return documentRowsFrom(path, offset, rules) ?? { rows: [], ends: [], offset: 0 };
  const handle = openSync(path, 'r');
  try {
    const size = fstatSync(handle).size;
    const start = offset > size ? 0 : offset;
    const remaining = size - start;
    const bounded = Number.isSafeInteger(rules.transcript_read_bytes) && rules.transcript_read_bytes > 0;
    let length = bounded ? Math.min(remaining, rules.transcript_read_bytes) : remaining;
    const rowLimit = Number.isSafeInteger(rules.transcript_row_bytes) && rules.transcript_row_bytes > 0
      ? Math.max(length, rules.transcript_row_bytes) : length;
    let bytes;
    for (;;) {
      // One read buffer is kept and reused: a fresh one each pass piled up outside the heap until a collection, and a
      // drain over a long transcript held hundreds of MB it had already finished with.
      if (readBuffer.length < length) readBuffer = Buffer.alloc(length);
      const read = readSync(handle, readBuffer, 0, length, start);
      bytes = readBuffer.subarray(0, read);
      if (bytes.includes(0x0a) || length >= remaining || length >= rowLimit) break;
      length = Math.min(remaining, rowLimit, Math.max(length + 1, length * 2));
    }
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (bounded && !end && remaining > bytes.length) return {
      rows: [], ends: [], offset: start, more: true,
      blocked_row: { offset: start, byte_limit: rowLimit },
    };
    const rows = [];
    const ends = [];
    let from = 0;
    while (from < end) {
      const stop = bytes.indexOf(0x0a, from);
      try { rows.push(JSON.parse(bytes.subarray(from, stop).toString('utf8'))); ends.push(start + stop + 1); } catch {}
      from = stop + 1;
    }
    return { rows, ends, offset: start + end,
      ...(bounded && start + end < size && bytes.length < remaining ? { more: true } : {}) };
  } finally { closeSync(handle); }
}

/** The transcript a session id names under a harness's roots (the newest when several match), or null. */
export function transcriptFor(sessionId, rules = settings) {
  if (typeof sessionId !== 'string' || !/^[0-9A-Za-z-]{8,}$/.test(sessionId)) return null;
  let best = null;
  let suffix = '.jsonl';
  const walk = (folder, depth) => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(suffix) && entry.name.includes(sessionId)) {
        const time = statSync(path).mtimeMs;
        if (!best || time > best.time) best = { path, time };
      }
    }
  };
  for (const harness of rules.harnesses) for (const root of harness.transcript_roots) {
    const home = root.home_variable && process.env[root.home_variable];
    suffix = root.suffix ?? '.jsonl';
    walk(home ? join(home, root.home_subfolder ?? '') : expand(root.folder), root.depth);
  }
  return best?.path ?? null;
}

/** The first complete rows of a JSON-lines transcript (a long session's file is never read whole for this): the
 *  first 64 KiB, then more of the head, up to `sweep.head_bytes`, until `enough(rows)` holds. */
function headRows(path, enough, rules = settings) {
  let handle;
  try { handle = openSync(path, 'r'); } catch { return []; }
  try {
    const size = fstatSync(handle).size;
    const most = rules.sweep?.head_bytes ?? 1_048_576;
    for (let length = 65_536; ; length *= 4) {
      const bytes = Buffer.alloc(Math.min(size, length, most));
      readSync(handle, bytes, 0, bytes.length, 0);
      const rows = [];
      for (const line of bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1).toString('utf8').split('\n')) {
        try { if (line) rows.push(JSON.parse(line)); } catch {}
      }
      if (enough(rows) || bytes.length >= size || bytes.length >= most) return rows;
    }
  } finally { closeSync(handle); }
}

/** The harness and session id of a transcript, read from its head, or null. A whole-document transcript is read
 *  whole: such files are one session each and small. */
export function sessionOfTranscript(path, rules = settings) {
  if (path.endsWith('.json')) {
    const found = documentRowsFrom(path, 0, rules);
    const sessionId = found && found.rows.map(row => at(row, found.harness.session_id_path)).find(value => typeof value === 'string' && value);
    return sessionId ? { harness: found.harness, sessionId } : null;
  }
  const named = rows => {
    const harness = harnessOf(rows, rules);
    const sessionId = harness && rows.map(row => at(row, harness.session_id_path)).find(value => typeof value === 'string' && value);
    return sessionId ? { harness, sessionId } : null;
  };
  return named(headRows(path, rows => named(rows) !== null, rules));
}

/** Whether the person's words can be in this session at all. A harness row may say which sessions the person types
 *  into (`person_when_session`, conditions on the row that names the session): a session another program started (a
 *  headless run an AI launched) or a helper thread that replays its parent's history holds the person's words only as
 *  copies or as an AI's prompt, so its user rows are not the person speaking. */
export function personSpeaksIn(path, harness, rules = settings) {
  if (!harness?.person_when_session || path.endsWith('.json')) return true;
  // A transcript's first rows never change, so a drain asks its head once, not on every pass.
  const key = `${path}\0${harness.id}`;
  if (headAnswers.has(key)) return headAnswers.get(key);
  const sessionRow = headRows(path, rows => rows.some(row => meets(row, harness.recognized_by)), rules)
    .find(row => meets(row, harness.recognized_by));
  const answer = sessionRow ? meets(sessionRow, harness.person_when_session) : true;
  if (sessionRow) { if (headAnswers.size >= 64) headAnswers.delete(headAnswers.keys().next().value); headAnswers.set(key, answer); }
  return answer;
}
const headAnswers = new Map();

/** Every transcript under every harness's roots that changed within `sweep.changed_within_days` and holds rows past
 *  its kept cursor. A turn-end hook reads its own chat only when that chat's turn ends, so a chat whose
 *  turn runs for hours, or whose hook never ran (the computer slept, the hook was cut off), is read here. */
export const transcriptSweepKey = ({ path, session_id: sessionId, harness }) => bytesToHex(blake3(new TextEncoder().encode(`${harness}\0${sessionId}\0${path}`)));

export function transcriptsBehind(rules = settings, { now = Date.now } = {}) {
  const since = now() - (rules.sweep?.changed_within_days ?? 7) * 86_400_000;
  const found = [];
  for (const harness of rules.harnesses) for (const root of harness.transcript_roots) {
    const home = root.home_variable && process.env[root.home_variable];
    const walk = (folder, depth) => {
      let entries = [];
      try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
        else if (entry.isFile() && entry.name.endsWith(root.suffix ?? '.jsonl') && (!root.name_includes || entry.name.includes(root.name_includes))) {
          let stat;
          try { stat = statSync(path); } catch { continue; }
          if (stat.mtimeMs >= since) found.push({ path, size: stat.size, changed: stat.mtimeMs });
        }
      }
    };
    walk(home ? join(home, root.home_subfolder ?? '') : expand(root.folder), root.depth);
  }
  const behind = [...new Map(found.map(file => [file.path, file])).values()].flatMap(file => {
    const session = sessionOfTranscript(file.path, rules);
    if (!session) return [];
    const cursor = readCursor(cursorPath(session.sessionId, rules));
    const behind = file.path.endsWith('.json') || cursor?.transcript !== file.path || cursor.offset < file.size
      || Boolean(rules.executions_path && session.harness.executions?.length && (cursor?.execution_offset ?? 0) < file.size);
    return behind ? [{ path: file.path, session_id: session.sessionId, harness: session.harness.id }] : [];
  });
  // Stable round-robin order prevents a recently changed chat from taking the first slot on every sweep.
  // The checkpoint stores only a digest, not a local transcript path or session identity.
  behind.sort((a, b) => transcriptSweepKey(a).localeCompare(transcriptSweepKey(b)));
  return behind;
}

/** Run one bounded sweep turn from a persisted FIFO of transcript digests. A still-pending chat goes to the tail, so
 *  one huge transcript cannot take the first slot again while smaller chats or newly discovered transcripts wait. */
export async function sweepTranscriptQueue(rules = settings, { now = Date.now, runTranscript } = {}) {
  if (typeof runTranscript !== 'function') throw new Error('A sweep transcript runner is required.');
  const deadline = now() + rules.time_box_ms;
  const orderPath = join(expand(rules.cursor_folder), rules.sweep?.cursor_file ?? 'sweep-order.json');
  const current = transcriptsBehind(rules, { now });
  const byKey = new Map(current.map(item => [transcriptSweepKey(item), item]));
  const kept = readCursor(orderPath)?.pending_keys;
  const pending = [...new Set([...(Array.isArray(kept) ? kept : []).filter(key => byKey.has(key)), ...byKey.keys()])];
  const most = pending.length;
  let processed = 0;
  writeCursor(orderPath, { pending_keys: pending });
  while (pending.length && processed < most && now() < deadline) {
    const key = pending[0];
    const item = byKey.get(key);
    let result = null;
    try { result = await runTranscript(item, Math.min(deadline, now() + (rules.drain_session_ms ?? Infinity))); } catch {}
    pending.shift();
    if (!result || result.pending > 0 || result.executions_pending > 0) pending.push(key);
    writeCursor(orderPath, { pending_keys: pending });
    processed += 1;
  }
  return { processed, pending: pending.length };
}

const cursorPath = (sessionId, rules) => join(expand(rules.cursor_folder), `${sessionId.replace(/[^0-9A-Za-z_-]/g, '_')}.json`);
const promptPath = (sessionId, rules) => join(expand(rules.cursor_folder), `${sessionId.replace(/[^0-9A-Za-z_-]/g, '_')}.prompts.json`);
const promptDigest = text => bytesToHex(blake3(new TextEncoder().encode(text)));
const readCursor = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function writeCursor(path, cursor) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, JSON.stringify(cursor));
  renameSync(`${path}.part`, path);
}

// A prompt hook can run before the transcript contains the new user row. Keep its time before sending, so the later
// Stop pass uses exactly that time and Trillion sees one message even if the prompt send timed out after acceptance.
function promptMarks(sessionId, rules) {
  const marks = readCursor(promptPath(sessionId, rules));
  return Array.isArray(marks) ? marks.filter(mark => typeof mark.digest === 'string' && !Number.isNaN(Date.parse(mark.at))) : [];
}
function writePromptMarks(sessionId, rules, marks) { writeCursor(promptPath(sessionId, rules), marks); }
function withPromptTimes(messages, sessionId, rules) {
  const marks = promptMarks(sessionId, rules);
  const used = new Set();
  const matched = [];
  const corrected = messages.map((message, position) => {
    if (message.speaker !== 'person') return message;
    const digest = promptDigest(message.text);
    const index = marks.findIndex((mark, at) => !used.has(at) && mark.digest === digest && Math.abs(Date.parse(mark.at) - Date.parse(message.at)) < 120_000);
    if (index < 0) return message;
    used.add(index);
    matched[position] = index;
    return { ...message, at: marks[index].at };
  });
  return { messages: corrected, marks, matched };
}

/** Whether the harness data says this process runs a session whose prompts are only trusted from the transcript. */
const awaitsTranscript = (harness, env) => (harness?.awaits_transcript_when ?? []).some(item => env[item.name] === item.is);

/** Whether the harness data says this transcript belongs to a session whose prompts are only trusted from their rows. */
const sessionAwaitsTranscript = (path, harness, rules) => {
  const conditions = harness?.awaits_transcript_when_session ?? [];
  return conditions.length > 0 && headRows(path, rows => rows.some(row => meets(row, conditions)), rules).some(row => meets(row, conditions));
};

/** Record the submitted prompt before the AI works. The transcript pass later retries it with the same time. */
export async function recordSubmittedPrompt(event, { rules = settings, send = sendToTrillion, key = () => keychainKey(rules.keychain_item), now = Date.now, env = process.env } = {}) {
  const sessionId = event.session_id ?? event.sessionId;
  const prompt = event.prompt ?? event.input;
  if (typeof sessionId !== 'string' || !/^[0-9A-Za-z-]{8,}$/.test(sessionId) || typeof prompt !== 'string'
    || !prompt.trim() || event.origin?.kind === 'peer' || event.attachment?.origin?.kind === 'peer'
    || event.promptSource === 'sdk' || event.turnOrigin === 'sdk' || event.entrypoint === 'sdk-cli'
    || event.promptSource === 'system' || event.turnOrigin === 'scheduled' || event.isMeta === true
    || injectedText(prompt, rules)) return { sent: 0, reason: 'no human prompt' };
  const path = [event.transcript_path, event.transcriptPath].find(item => typeof item === 'string' && existsSync(item)) ?? transcriptFor(sessionId, rules);
  if (path) {
    const cursor = readCursor(cursorPath(sessionId, rules));
    const rows = rowsFrom(path, cursor?.transcript === path ? cursor.offset : 0, rules).rows;
    const harness = rules.harnesses.find(item => item.id === event.harness) ?? harnessOf(rows, rules);
    if (event.origin?.kind !== 'human' && rows.some(row => row.type === 'attachment' && row.attachment?.type === 'queued_command'
      && row.attachment?.origin?.kind === 'peer' && row.attachment?.prompt === prompt
      && Math.abs(Date.parse(row.timestamp) - now()) < 120_000)) return { sent: 0, reason: 'peer prompt' };
    if (rows.some(row => row.type === 'user' && (row.promptSource === 'sdk' || row.turnOrigin === 'sdk' || row.entrypoint === 'sdk-cli')
      && row.message?.content === prompt && Math.abs(Date.parse(row.timestamp) - now()) < 120_000)) {
      return { sent: 0, reason: 'sdk prompt' };
    }
    if (harness && !personSpeaksIn(path, harness, rules)) return { sent: 0, reason: 'not a session the person types into' };
    const said = harness ? messagesOf(rows, harness, { sessionId }, rules).messages : [];
    const sameWords = message => message.text === prompt || message.text.trim() === prompt.trim()
      || prompt.includes(`## My request:\n${message.text}`);
    // A row the harness data says another speaker wrote (a background job's brief) is that speaker's, never the person's.
    if (said.some(message => message.speaker === 'peer' && sameWords(message) && Math.abs(Date.parse(message.at) - now()) < 120_000)) {
      return { sent: 0, reason: 'peer prompt' };
    }
    const verified = harness && said.filter(message =>
      message.speaker === 'person' && sameWords(message) && Math.abs(Date.parse(message.at) - now()) < 120_000)
      .sort((a, b) => Math.abs(Date.parse(a.at) - now()) - Math.abs(Date.parse(b.at) - now()))[0];
    if (verified) {
      try {
        return { sent: await send([verified], { rules, deadline: now() + rules.time_box_ms, key: key() }) ? 1 : 0,
          conversation_id: verified.conversation_id };
      } catch { return { sent: 0, conversation_id: verified.conversation_id }; }
    }
    if (harness?.prompt_requires_transcript || awaitsTranscript(harness, env) || sessionAwaitsTranscript(path, harness, rules) || (harness?.await_human_transcript && event.origin?.kind !== 'human')) return { sent: 0, reason: 'await human transcript' };
  }
  const harness = rules.harnesses.find(item => item.id === event.harness);
  if (!harness) return { sent: 0, reason: 'unknown harness' };
  if (harness.prompt_requires_transcript || awaitsTranscript(harness, env)) return { sent: 0, reason: 'await human transcript' };
  if (harness.await_human_transcript && event.origin?.kind !== 'human' && !path) return { sent: 0, reason: 'await human transcript' };
  const at = new Date(now()).toISOString();
  const marks = promptMarks(sessionId, rules);
  marks.push({ digest: promptDigest(prompt), at });
  writePromptMarks(sessionId, rules, marks);
  const message = { conversation_id: `${harness.id}:${sessionId}`, app: harness.app, speaker: 'person', text: prompt, at };
  try {
    return { sent: await send([message], { rules, deadline: now() + rules.time_box_ms, key: key() }) ? 1 : 0, conversation_id: message.conversation_id };
  } catch { return { sent: 0, conversation_id: message.conversation_id }; }
}

// Codex can fire UserPromptSubmit before it appends the user response_item. This
// detached child waits for that exact row, so it can admit a genuine prompt
// during the turn without treating a compaction or injected note as the person.
export async function recordSubmittedPromptWhenTranscriptArrives(event, options = {}) {
  const waitMs = options.waitMs ?? (options.rules ?? settings).prompt_wait_ms ?? 0;
  const pollMs = options.pollMs ?? 250;
  const until = Date.now() + waitMs;
  for (;;) {
    const result = await recordSubmittedPrompt(event, options);
    if (result.reason !== 'await human transcript' || Date.now() >= until) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, until - Date.now())));
  }
}

/** A successful HTTP reply is not enough: each founder message must also enter the work arrival road. */
export function acceptedBatch(messages, result) {
  if (!Array.isArray(result?.ids) || result.ids.length !== messages.length || result.ids.some(id => typeof id !== 'string' || !id)) return false;
  const personIds = result.ids.filter((_, index) => messages[index].speaker === 'person');
  if (!personIds.length) return true;
  return Array.isArray(result.arrivals) && result.arrivals.length === personIds.length
    && result.arrivals.every((arrival, index) => arrival?.message_id === personIds[index] && typeof arrival?.arrival_id === 'string');
}

/**
 * How many messages from `start` go in one request: a person's message, or one carrying files, alone (each reaches the
 * arrival road on its own); otherwise the run of AI messages that follows, up to `most`.
 */
export function batchAt(messages, start, most) {
  const alone = message => message.speaker === 'person' || (message.attachment_sources ?? []).length > 0;
  if (alone(messages[start])) return 1;
  let end = start + 1;
  while (end < messages.length && end - start < most && !alone(messages[end])) end += 1;
  return end - start;
}

async function keepTranscriptAttachments(message, { rules, deadline, key }) {
  const attachments = [];
  for (const [index, source] of (message.attachment_sources ?? []).entries()) {
    const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' })[source.media_type] ?? '.bin';
    const safe = value => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'message';
    const name = `/messages/${safe(message.conversation_id)}/${safe(message.source_ref ?? message.at)}-${index + 1}${extension}`;
    const response = await fetch(`${rules.origin.replace(/\/$/, '')}/mcp/api/namespace/write`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, content_base64: source.data, media_type: source.media_type, app: message.app }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) return null;
    const file = await response.json().catch(() => null);
    if (typeof file?.identity !== 'string') return null;
    attachments.push(file.identity);
  }
  return attachments;
}

/** Historical turns are private evidence, never arrivals or new instructions. An older service refuses this route. */
export async function sendHistoricalToTrillion(messages, { rules = settings, deadline, key } = {}) {
  if (!messages.length || messages.some(message => !message.source_ref || message.conversation_id !== messages[0].conversation_id || message.app !== messages[0].app)) return false;
  const attachments = {};
  const archived = [];
  for (const message of messages) {
    const kept = await keepTranscriptAttachments(message, { rules, deadline, key });
    if (!kept) return false;
    for (const identity of kept) attachments[identity] = identity;
    archived.push({ id: message.source_ref, speaker: message.speaker, text: message.text, at: message.at, model: message.model,
      metadata: { attachments: kept.map(id => ({ id })) } });
  }
  const response = await fetch(`${rules.origin.replace(/\/$/, '')}/mcp/api/chats/import-history`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ app: messages[0].app, conversation: { conversation_id: messages[0].conversation_id, messages: archived }, attachments }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => null);
  return result?.into === 'private' && result.conversation_id === messages[0].conversation_id
    && Number.isSafeInteger(result.messages) && result.messages >= messages.length
    && result.added + result.already_there === result.messages && result.missing_attachments?.length === 0;
}

/** Sends one batch (batchAt) to Trillion; resolves true only when every message was kept and founder work reached the arrival road. */
export async function sendToTrillion(messages, { rules = settings, deadline, key } = {}) {
  if (!messages.length) return false;
  if (rules.historical) return sendHistoricalToTrillion(messages, { rules, deadline, key });
  if (messages.length > 1) {
    if (messages.some(message => message.speaker === 'person' || (message.attachment_sources ?? []).length)) return false;
    const response = await fetch(`${rules.origin.replace(/\/$/, '')}${rules.messages_path}`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: messages.map(message => ({ ...message, attachments: [], attachment_sources: undefined })) }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) return false;
    return acceptedBatch(messages, await response.json().catch(() => null));
  }
  const message = messages[0];
  const fromPerson = message.speaker === 'person';
  const left = Math.max(1, deadline - Date.now());
  const attachments = await keepTranscriptAttachments(message, { rules, deadline, key });
  if (!attachments) return false;
  const response = await fetch(`${rules.origin.replace(/\/$/, '')}${fromPerson ? rules.inbound_path : rules.messages_path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(fromPerson ? {
      route: message.app, source_id: message.conversation_id, conversation_id: message.conversation_id,
      text: message.text, at: message.at, from_person: true, ...(attachments.length ? { files: attachments.map(id => ({ id })) } : {}),
      ...(message.source_ref ? { source_ref: message.source_ref } : {}),
      ...(message.origin ? { origin: message.origin } : {}),
    } : { messages: [{ ...message, attachments, attachment_sources: undefined }] }), signal: AbortSignal.timeout(Math.min(left, Math.max(1, deadline - Date.now()))),
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => null);
  return fromPerson
    ? typeof result?.message_id === 'string' && typeof result?.arrival_id === 'string'
    : acceptedBatch(messages, result);
}

const keychainKey = name => requireAccountKey({ item: name, timeout: 2000 });

/**
 * Records everything new in one session's transcript. `event` is the harness's turn-end event (transcript_path,
 * session_id) or { transcript_path } for a backfill. Returns { sent, pending, conversation_id } and never throws.
 */
export async function recordNew(event, { rules = settings, send = sendToTrillion, sendExecution = sendExecutionToTrillion, key = () => keychainKey(rules.keychain_item), now = Date.now } = {}) {
  const deadline = now() + rules.time_box_ms;
  const path = [event.transcript_path, event.transcriptPath].find(item => typeof item === 'string' && existsSync(item))
    ?? transcriptFor(event.session_id ?? event.sessionId, rules);
  if (!path) return { sent: 0, pending: 0, reason: 'no transcript' };
  const whole = event.session_id ? null : rowsFrom(path, 0, rules).rows;
  let sessionId = event.session_id ?? event.sessionId;
  let harness = null;
  if (whole) {
    harness = harnessOf(whole, rules);
    sessionId = harness && whole.map(row => at(row, harness.session_id_path)).find(value => typeof value === 'string' && value);
  }
  if (!sessionId) return { sent: 0, pending: 0, reason: 'no session id' };
  const where = cursorPath(sessionId, rules);
  const cursor = readCursor(where);
  const kept = cursor?.transcript === path && (path.endsWith('.json') || cursor.offset <= statSync(path).size)
    ? cursor : { transcript: path, offset: 0, context: {} };
  const { rows, ends, offset, more, blocked_row } = rowsFrom(path, kept.offset, rules);
  if (blocked_row) return { sent: 0, pending: 1, conversation_id: `${kept.harness ?? event.harness ?? 'transcript'}:${sessionId}`, reason: 'transcript row exceeds the bounded reader', blocked_row };
  harness = harness ?? rules.harnesses.find(candidate => candidate.id === kept.harness) ?? harnessOf(rows.length ? rows : rowsFrom(path, 0, rules).rows, rules);
  if (!harness) return { sent: 0, pending: 0, reason: 'unknown harness' };
  // Retain queued source evidence independently of sendable messages and execution acknowledgements.
  // Reading later rows can continue; a restart reconstructs unresolved queues from this same atomic cursor.
  const waiting = Array.isArray(kept.deferred) ? kept.deferred : [];
  const parsed = messagesOf([...waiting.map(item => item.row), ...rows], harness, { sessionId, context: kept.context, ends: [...waiting.map(item => item.offset), ...ends], personSpeaks: personSpeaksIn(path, harness, rules) }, rules);
  const { messages, marks: promptTimes, matched } = withPromptTimes(parsed.messages, sessionId, rules);
  const { marks, context } = parsed;
  // One existing cursor owns both acknowledgements. Advancing messages cannot skip a refused tool receipt.
  const nativeRows = !rules.historical && rules.executions_path && harness.executions?.length ? rowsFrom(path, kept.execution_offset ?? 0, rules) : null;
  let native;
  try { native = nativeRows ? executionsOf(nativeRows.rows, harness, { sessionId, ends: nativeRows.ends, context: kept.execution_context ?? {} }, rules) : { executions: [], marks: [], context: {} }; }
  catch (error) { return { sent: 0, pending: messages.length, executions_sent: 0, executions_pending: 1, execution_capture: 'metadata_limit', reason: error.message, conversation_id: `${harness.id}:${sessionId}` }; }
  let executions_sent = 0;
  const conversation_id = `${harness.id}:${sessionId}`;
  let sent = 0;
  let secret = null;
  try {
    for (let start = 0; start < messages.length && now() < deadline;) {
      const size = rules.historical ? Math.min(rules.batch_size, messages.length - start) : batchAt(messages, start, rules.batch_size);
      secret ??= key();
      if (!(await send(messages.slice(start, start + size), { rules, deadline, key: secret }))) break;
      start += size;
      sent = start;
    }
  } catch {}
  try {
    for (const receipt of native.executions) {
      if (now() >= deadline) break;
      secret ??= key();
      if (!(await sendExecution(receipt, { rules, deadline, key: secret }))) break;
      executions_sent += 1;
    }
  } catch {}
  // Several calls may share one transcript row. Do not pass that row until all of its receipts were accepted.
  const failedOffset = native.marks[executions_sent]?.offset;
  const acceptedMark = native.marks.slice(0, executions_sent).findLast(mark => failedOffset === undefined || mark.offset < failedOffset);
  const nativeCursor = nativeRows ? { execution_offset: executions_sent === native.executions.length ? nativeRows.offset : acceptedMark?.offset ?? kept.execution_offset ?? 0,
    execution_context: executions_sent === native.executions.length ? native.context : acceptedMark?.context ?? kept.execution_context ?? {} } : {};
  // The cursor passes the last row whose message was kept (every row when all were), so a long history sent over
  // several turn ends moves forward each time; a row read twice is the same message (same time and text), never two.
  if (sent === messages.length) writeCursor(where, { transcript: path, offset, harness: harness.id, context, deferred: parsed.deferred, ...nativeCursor });
  else if (sent) writeCursor(where, { transcript: path, offset: marks[sent - 1].offset, harness: harness.id, context: marks[sent - 1].context,
    deferred: parsed.deferred.filter(item => item.offset <= marks[sent - 1].offset), ...nativeCursor });
  else if (executions_sent || (nativeCursor.execution_offset ?? 0) > (kept.execution_offset ?? 0)) {
    // A refused message does not prevent an independently accepted or tool-free execution page from advancing.
    // Keep the original message offset/context; only execution acknowledgements cross their own boundary.
    writeCursor(where, { ...kept, harness: harness.id, ...nativeCursor });
  }
  if (sent && matched.length) {
    const consumed = new Set(matched.slice(0, sent).filter(index => index !== undefined));
    writePromptMarks(sessionId, rules, promptTimes.filter((_, index) => !consumed.has(index)));
  }
  // A turn-end hook may have just kept a final answer. Wake the source-bound
  // receiver only for a final row actually accepted by Trillion; that receiver
  // independently checks the original transcript before signing the return.
  const spec = rules.historical ? null : harness.source_return;
  const source_return_candidates = !spec ? [] : rows.filter(row => meets(row, spec.when) && typeof at(row, spec.id_path) === 'string').flatMap(row => {
    const said = wordsOf(at(row, spec.text.path), spec.text, rules);
    if (/^\s*<heartbeat>/i.test(said) || !messages.slice(0, sent).some(message =>
      message.speaker === 'ai' && message.text === said && message.at === at(row, harness.time_path))) return [];
    return [...new Set(said.match(/\bh_[A-Za-z0-9]+\b/g) ?? [])].map(handoff_id => ({ handoff_id,
      transcript_message_id: at(row, spec.id_path), source_id: conversation_id, text: said }));
  });
  return { sent, pending: messages.length - sent + (more ? 1 : 0), awaiting_source: parsed.deferred.length, conversation_id, source_return_candidates,
    executions_sent, executions_pending: native.executions.length - executions_sent + (nativeRows?.more ? 1 : 0),
    ...(nativeRows?.blocked_row ? { execution_blocked_row: nativeRows.blocked_row } : {}),
    execution_capture: nativeRows ? 'supported_transcript_after_dispatch' : 'unsupported_or_disabled',
    ...(rules.transcript_read_bytes ? { advanced_bytes: Math.max(0, (sent === messages.length ? offset : sent ? marks[sent - 1].offset : kept.offset) - kept.offset),
      execution_advanced_bytes: Math.max(0, (nativeCursor.execution_offset ?? kept.execution_offset ?? 0) - (kept.execution_offset ?? 0)) } : {}) };
}

// A lock file holding its owner's pid: taken when free, or when its owner has ended; null while a live process holds it.
export function holdLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const take = () => { const fd = openSync(path, 'wx'); writeFileSync(fd, String(process.pid)); return fd; };
  let fd;
  try { fd = take(); }
  catch {
    let owner = null;
    try { owner = Number(readFileSync(path, 'utf8')); } catch {}
    if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); return null; } catch {} }
    try { unlinkSync(path); fd = take(); } catch { return null; }
  }
  return { release() { try { closeSync(fd); } catch {} try { unlinkSync(path); } catch {} } };
}

// A turn-end hook is deliberately short. If it finds a backlog, continue it in
// this same recorder owner after the hook exits, with one session lock so a later
// hook cannot race its cursor. The child stops when the cursor reaches the end;
// it is not a scheduler or a second intake path.
export async function drainTranscript(event, { rules = settings, send = sendToTrillion, sendExecution = sendExecutionToTrillion, key = () => keychainKey(rules.keychain_item), now = Date.now, sourceReturn = startSourceReturnCheck, until: stopAt } = {}) {
  const path = event.transcript_path ?? event.transcriptPath;
  const sessionId = event.session_id ?? event.sessionId;
  if (typeof path !== 'string' || typeof sessionId !== 'string') return { drained: 0, pending: 0, reason: 'missing transcript' };
  const lock = holdLock(join(expand(rules.cursor_folder), `${sessionId}.drain.lock`));
  if (!lock) return { drained: 0, pending: 0, reason: 'already draining' };
  let drained = 0;
  try {
    const drainRules = { ...rules, time_box_ms: Math.max(rules.time_box_ms, 30_000) };
    // One chat's turn at the computer's one drain (and at a sweep) is drain_session_ms; a chat with more behind it waits for the next turn,
    // so a 599 MB chat cannot hold the others back.
    const until = stopAt ?? now() + (rules.drain_session_ms ?? 10 * 60_000);
    // A pass that kept nothing (Trillion busy, or refusing writes) waits twice as long before the next, up to
    // drain_wait_ms.most, and one that kept something starts again from drain_wait_ms.first: every chat's drainer
    // retrying every half second kept a store that refused writes at hundreds of calls a minute.
    let wait = rules.drain_wait_ms.first;
    for (let pass = 0; ; pass++) {
      // The first pass of a turn always runs with its whole time box: a turn that started late (a computer too busy to reach it
      // before its time ran out) tried nothing and sent nothing, and the next turn started late too. Later passes keep to the turn.
      if (pass > 0 && now() >= until) return { drained, pending: 1, reason: 'drain time box' };
      const passRules = { ...drainRules, time_box_ms: pass === 0 ? drainRules.time_box_ms : Math.min(drainRules.time_box_ms, Math.max(1, until - now())) };
      const result = await recordNew({ transcript_path: path, session_id: sessionId }, { rules: passRules, send, sendExecution, key, now });
      collectGarbage();
      drained += result.sent ?? 0;
      sourceReturn(result.source_return_candidates);
      if (!result.pending && !result.executions_pending) return { drained, pending: 0 };
      if (result.blocked_row) return { drained, pending: result.pending, reason: result.reason, blocked_row: result.blocked_row };
      if (result.execution_blocked_row) return { drained, pending: 1, reason: 'execution transcript row exceeds the bounded reader', execution_blocked_row: result.execution_blocked_row };
      if ((result.advanced_bytes || result.execution_advanced_bytes) && !result.sent && !result.executions_sent) continue;
      if (result.sent || result.executions_sent) { wait = rules.drain_wait_ms.first; continue; }
      if (now() + wait >= until) return { drained, pending: 1, reason: 'drain time box' };
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, rules.drain_wait_ms.most);
    }
  } finally {
    lock.release();
  }
}

/** Full archival has its own checkpoint: live intake may already have passed withheld historical person rows. */
export function historicalRules(rules = settings) {
  const history = rules.history;
  if (!history?.cursor_folder || join(expand(history.cursor_folder)) === join(expand(rules.cursor_folder))) {
    throw new Error('Historical recording needs its own checkpoint folder.');
  }
  return { ...rules, historical: true, cursor_folder: history.cursor_folder,
    transcript_read_bytes: history.read_bytes ?? 4 * 1024 * 1024,
    transcript_row_bytes: history.row_bytes ?? 8 * 1024 * 1024 };
}

// A test seam: a loopback origin and a key read from a file stand in for Trillion and the Keychain. Anything but a loopback
// origin is ignored, so no environment can send the account's words, or its key, to another place.
const stand = (() => {
  const origin = process.env.TRILLION_RECORDER_TEST_ORIGIN, keyFile = process.env.TRILLION_RECORDER_TEST_KEY_FILE;
  return origin && keyFile && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
    ? { rules: { origin }, send: { key: () => readFileSync(keyFile, 'utf8').trim() } } : { rules: {}, send: {} };
})();

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  if (process.argv.includes('--sweep')) {
    // Every transcript of every harness with rows past its cursor is read here in a persisted round-robin order: harnesses with no
    // turn-end hook of their own, and chats whose own hook has not run yet (a turn still going, a hook that never ran).
    // It runs from every harness's Stop and on the helper's schedule (wake-handlers/keep-every-message.mjs). It blocks
    // no turn, so it has its own time box; a file it does not reach is read on the next sweep. Each chat is read under
    // its drain lock, so two sweeps, or a sweep and a backlog drain, never read one chat at once.
    // One sweep runs on this computer at a time: every chat's Stop and every helper start one, and two at once read
    // every transcript twice and sent the same rows to Trillion side by side (2026-10-07, the busiest account's store
    // was saturated). A sweep that finds another running ends; the running one, or the next, reads what is new.
    const history = process.argv.includes('--all-history');
    const rules = { ...(history ? historicalRules(settings) : settings),
      time_box_ms: settings.sweep_time_box_ms ?? settings.time_box_ms,
      ...(history ? { sweep: { ...settings.sweep, changed_within_days: Infinity } } : {}) };
    const sweeping = holdLock(join(expand(rules.cursor_folder), 'sweep.lock'));
    if (!sweeping) process.exit(0);
    await sweepTranscriptQueue(rules, { runTranscript: (behind, until) => behind.path.endsWith('.json')
      ? recordNew({ transcript_path: behind.path }, { rules })
      : drainTranscript({ transcript_path: behind.path, session_id: behind.session_id }, { rules: { ...rules, ...stand.rules }, ...stand.send, until }) });
    sweeping.release();
    process.exit(0);
  }
  const backfill = process.argv.indexOf('--transcript');
  const drain = process.argv.includes('--drain');
  let event = {};
  if (backfill !== -1) event = { transcript_path: process.argv[backfill + 1] };
  else {
    // The turn must never wait on this: past the time box the process ends, whatever it was doing.
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try { event = JSON.parse(raw || '{}'); } catch {}
    keepHookRunOnExit(import.meta.url, event);
  }
  const harnessFlag = process.argv.indexOf('--harness');
  if (harnessFlag !== -1) event.harness = process.argv[harnessFlag + 1];
  const sessionFlag = process.argv.indexOf('--session-id');
  if (sessionFlag !== -1) event.session_id = process.argv[sessionFlag + 1];
  const promptEvent = event.hook_event_name === 'UserPromptSubmit' || event.hookEventName === 'UserPromptSubmit';
  const waitsForTranscript = promptEvent && settings.harnesses.find(item => item.id === event.harness)?.prompt_wait === true;
  if (backfill === -1) setTimeout(() => process.exit(0), settings.time_box_ms + (waitsForTranscript ? settings.prompt_wait_ms : 0) + 500).unref();
  let rules = settings;
  if (backfill !== -1 && !drain) rules = { ...historicalRules(settings), time_box_ms: 10 * 60 * 1000 };
  if (drain) {
    // One backlog drain runs on this computer at a time (`drain.lock`): a drain started while another runs ends at once, and
    // the chat it was for is read on the next sweep (every sweep.every_seconds), from its cursor, which is the spool. A drain
    // ends at drain_most_ms whatever it is waiting on. Dozens of chats each starting their own drain held 0.5 GB apiece for
    // minutes while the account refused writes (2026-10-21, 138 GB in all).
    const machine = holdLock(join(expand(settings.cursor_folder), 'drain.lock'));
    if (!machine) process.exit(0);
    setTimeout(() => { machine.release(); process.exit(0); }, settings.drain_most_ms).unref();
    await drainTranscript(event, { rules: { ...settings, ...stand.rules }, ...stand.send }).catch(() => null);
    machine.release();
    process.exit(0);
  }
  const result = await (promptEvent
    ? waitsForTranscript ? recordSubmittedPromptWhenTranscriptArrives(event, { rules }) : recordSubmittedPrompt(event, { rules })
    : recordNew(event, { rules })).catch(() => ({ sent: 0 }));
  const drainPath = event.transcript_path ?? event.transcriptPath ?? transcriptFor(event.session_id ?? event.sessionId, settings);
  if (backfill === -1 && !promptEvent && (result.pending > 0 || result.executions_pending > 0) && drainPath && (event.session_id ?? event.sessionId)) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--drain', '--transcript', drainPath,
      '--session-id', event.session_id ?? event.sessionId], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  if (backfill === -1 && !promptEvent) startSourceReturnCheck(result.source_return_candidates);
  if (backfill !== -1) console.log(JSON.stringify(result));
  process.exit(0);
}
