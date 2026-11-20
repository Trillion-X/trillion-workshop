#!/usr/bin/env node
// harness/read-cloud-sessions.mjs
//
// Purpose
//   Reads the person's Claude Code cloud sessions (claude.ai/code) for one Claude sign-in on this computer: the list
//   of sessions with their repositories, branches and state, and each session's own messages, cut down to what says
//   what it was asked, what it says it did, what it says is left, any pull request it made and any question it put
//   to the person. It reads the same account pages Claude Code itself reads for `--teleport` (/v1/sessions and
//   /v1/sessions/<id>/events), so no checkout and no attach is needed.
//
//     node harness/read-cloud-sessions.mjs list <config-folder> <out.json>
//     node harness/read-cloud-sessions.mjs read <config-folder> <list.json> <out-folder> [at-once]
//     node harness/read-cloud-sessions.mjs read-first <config-folder> <session-id> [offset] [length] [snapshot]
//   read-first reads only that session, printing a bounded base64 page of the first actual user's decoded UTF-8
//   text. Continue at next_after_byte with the returned snapshot. It never substitutes a later text-only ask for
//   a non-text first message. Text blocks are joined with newlines, as in the existing summary projection; this
//   is not a lossless copy of attachments, block boundaries or the provider's original JSON wire bytes.
//     node harness/read-cloud-sessions.mjs send <config-folder> <session-id> [<brief>]
//     node harness/read-cloud-sessions.mjs start <config-folder> <owner/repo[,owner/repo...]> <title> [<brief>]
//
//   <brief> is where the message comes from, so no one writes a brief file: a record id of the person's Trillion
//   (`record:brief:release-plan`; read with records:read through the Mac app's local door, its type the id up to its
//   last `:`, its text the record's value when that is text, else the value's brief, text, body, message or says),
//   `-` or nothing for standard input, or a file that already exists.
//
//   <config-folder> is a CLAUDE_CONFIG_DIR folder name under the home folder (for example .claude-account1).
//   `read` writes <out-folder>/<session-id>.json per session and skips sessions already written, so a cut-off run
//   is simply run again. `send` posts the brief to the session as the person's next message (the
//   claude.ai/code page's own road, POST /v1/sessions/<id>/events), which starts the session's next turn, and prints
//   the session's status and its first answer after it. `start` makes a new session with every repository named
//   cloned from its main (the first is the one it works in), with the brief as its first message, in
//   the environment of that sign-in's latest cloud session: `claude --cloud` attaches only the repository it is run in,
//   and a session that asks for a second one waits on a permission only the person can give.
//
// Non-negotiable invariants
//   1. The only changes it makes are `send` (one message to the one session named) and `start` (one new session per
//      call). It never archives, renames, interrupts or stops a session, and `list` and `read` change nothing.
//   2. The sign-in token is read from the Keychain item Claude Code keeps for that folder
//      ("Claude Code-credentials-" + the first 8 hex of the folder path's SHA-256), held in memory and put only in
//      the Authorization header; it is never printed, logged or passed as an argument.
//   3. An expired sign-in is refused with its expiry time; it is never refreshed here (Claude Code owns refresh).
//
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { text as readAll } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { requireAccountKey } from './account-key.mjs';
import { localDoorAddress } from './local-door.mjs';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const API = 'https://api.anthropic.com';
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Read only the existing Claude Code sign-in. macOS uses Keychain; Linux uses the CLI's private credentials file.
 * Never echo, persist, refresh, or forward the access token except as the provider Authorization header.
 */
export function signIn(folderName, { home = homedir(), system = platform(), read = readFileSync, keychain = execFileSync, now = Date.now() } = {}) {
  if (typeof folderName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(folderName) || ['.', '..'].includes(folderName)) {
    throw new Error('Name one Claude config folder directly beneath the home folder.');
  }
  const folder = join(home, folderName);
  const account = JSON.parse(read(join(folder, '.claude.json'), 'utf8'));
  const org = account.oauthAccount?.organizationUuid;
  if (typeof org !== 'string' || !org) throw new Error(`${folderName}: no Claude organization in its existing sign-in`);
  let raw;
  if (system === 'darwin') {
    const item = `Claude Code-credentials-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
    raw = keychain('security', ['find-generic-password', '-s', item, '-w'], { encoding: 'utf8' });
  } else if (system === 'linux') {
    raw = read(join(folder, '.credentials.json'), 'utf8');
  } else {
    throw new Error(`${folderName}: this sign-in reader supports macOS and Linux only`);
  }
  const oauth = JSON.parse(raw).claudeAiOauth;
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken || !Number.isFinite(oauth.expiresAt)) {
    throw new Error(`${folderName}: no valid Claude subscription sign-in found`);
  }
  if (oauth.expiresAt <= now) throw new Error(`${folderName}: sign-in expired at ${new Date(oauth.expiresAt).toString()}; refresh it with Claude Code`);
  return { org, token: oauth.accessToken };
}

async function get(account, path, body, { request = fetch, includeErrorBody = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await request(API + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${account.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'x-organization-uuid': account.org,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${path}: HTTP ${response.status}${includeErrorBody ? ` ${(await response.text()).slice(0, 300)}` : ''}`);
  }
}

async function everyPage(account, path, limit, { request = fetch, until = () => false, includeErrorBody = true, strict = false } = {}) {
  const all = [];
  const seen = new Set();
  let after = null;
  for (;;) {
    const page = await get(account, `${path}?limit=${limit}${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, undefined, { request, includeErrorBody });
    if (strict && (!page || typeof page !== 'object' || Array.isArray(page) || typeof page.has_more !== 'boolean')) throw new Error('The session events page is incomplete: has_more must be a boolean.');
    if (!Array.isArray(page.data)) throw new Error('The session events page has no data array.');
    if (strict && page.has_more && (!page.data.length || typeof page.last_id !== 'string' || !page.last_id || seen.has(page.last_id))) throw new Error('The session events cursor did not advance; the first user source is incomplete.');
    all.push(...page.data);
    if (until(all) || !page.has_more) return all;
    if (!page.data.length || page.last_id === after) return all;
    seen.add(page.last_id);
    after = page.last_id;
  }
}

function sessionRow(session) {
  const context = session.session_context ?? {};
  return {
    id: session.id,
    title: session.title,
    session_status: session.session_status,
    status_bucket: session.status_bucket,
    created_at: session.created_at,
    updated_at: session.updated_at,
    task_summary: session.task_summary ?? session.external_metadata?.task_summary ?? null,
    sources: (context.sources ?? []).map(source => ({ url: source.url, revision: source.revision ?? null })),
    outcomes: (context.outcomes ?? []).map(outcome => outcome.git_info ?? outcome),
    branches: session.external_metadata?.current_branches ?? null,
    tags: session.tags,
    url: session.session_url,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

const firstUserIndex = events => events.findIndex(event => event?.type === 'user' && event.message
  && (event.message.role === undefined || event.message.role === 'user')
  && !event.parent_tool_use_id && !(Array.isArray(event.message.content) && event.message.content.some(block => block?.type === 'tool_result')));
const FIRST_TEXT_BYTES = 16 * 1024;
const MOST_TEXT_BYTES = 64 * 1024;

function checkTextPage({ offset = 0, length = FIRST_TEXT_BYTES, snapshot } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MOST_TEXT_BYTES) throw new Error(`offset must be a nonnegative byte integer; length must be 1..${MOST_TEXT_BYTES}.`);
  if (snapshot !== undefined && !/^1f:[a-f0-9]{64}$/.test(snapshot)) throw new Error('snapshot must be the returned BLAKE3 identity.');
  if (offset > 0 && snapshot === undefined) throw new Error('Continuing text requires the first page’s snapshot.');
}

/** Raw text bytes only; the snapshot pins the full decoded source event, including its non-text content. */
export function firstUserTextPage(events, { session, offset = 0, length = FIRST_TEXT_BYTES, snapshot } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array.');
  checkTextPage({ offset, length, snapshot });
  const index = firstUserIndex(events);
  if (index < 0) {
    if (offset || snapshot !== undefined) throw new Error('The first user source changed or is unavailable.');
    return { status: 'no-user-message', source: null, byte_page: null };
  }
  const event = events[index];
  const pinned = makeHashCodeHexFromJson({ session: session ?? null, event });
  if (snapshot !== undefined && snapshot !== pinned) throw new Error('The first user source changed; restart at byte zero.');
  const content = event.message.content;
  const blocks = Array.isArray(content) ? content.filter(block => block?.type === 'text') : [];
  if (blocks.some(block => typeof block.text !== 'string')) throw new Error('The first user message has an invalid text block.');
  const hasText = typeof content === 'string' || blocks.length > 0;
  const nonText = Array.isArray(content) ? content.length - blocks.length : typeof content === 'string' ? 0 : 1;
  const text = hasText ? textOf(content) : '';
  if (!text.isWellFormed()) throw new Error('The first user text contains an unpaired surrogate and cannot be represented losslessly as UTF-8.');
  const bytes = Buffer.from(text, 'utf8');
  if (offset > bytes.length) throw new Error('offset is past the end of the first user text.');
  const part = bytes.subarray(offset, Math.min(offset + length, bytes.length));
  const next = offset + part.length;
  return {
    status: hasText ? nonText ? 'mixed-user-message' : 'text-user-message' : 'non-text-user-message',
    source: { session: session ?? null, event_id: typeof event.uuid === 'string' ? event.uuid : typeof event.id === 'string' ? event.id : null, event_index: index, snapshot: pinned,
      projection: typeof content === 'string' ? 'text-string' : 'text-blocks-joined-with-newlines',
      non_text_blocks: nonText, whole_message: typeof content === 'string' },
    byte_page: { total: bytes.length, blake3: makeHashCodeHexFromBytes(bytes).slice(3), offset, length: part.length,
      base64: part.toString('base64'), next_after_byte: next < bytes.length ? next : null, complete: next === bytes.length },
  };
}

/** One exact session, using the existing header-authenticated GET transport; never lists or changes sessions. */
export async function readFirstUserText(folder, session, page, { authenticate = signIn, request = fetch } = {}) {
  if (typeof folder !== 'string' || !/^[A-Za-z0-9._-]+$/.test(folder) || ['.', '..'].includes(folder)) throw new Error('Name one config folder directly under the home folder.');
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw new Error('Name one exact session id without path or query characters.');
  // Validate bounds before touching the sign-in or the provider.
  checkTextPage(page);
  const account = await authenticate(folder);
  const events = await everyPage(account, `/v1/sessions/${session}/events`, 1000,
    { request, includeErrorBody: false, strict: true, until: events => firstUserIndex(events) >= 0 });
  return firstUserTextPage(events, { ...page, session });
}

// What a finished session says: the task it was given, the person's later messages, its messages to the person
// since the last of them, the pull requests it named and the questions it asked.
export function whatItSaid(events) {
  const asked = [];
  const answered = [];
  const pullRequests = new Set();
  const pushes = [];
  const questions = [];
  for (const event of events) {
    const content = event.message?.content;
    if (event.type === 'user' && event.message) {
      const text = textOf(content);
      if (text && !event.parent_tool_use_id) asked.push({ at: event.created_at, text });
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result') continue;
        const output = typeof block.content === 'string' ? block.content : textOf(block.content);
        for (const match of output.matchAll(PR_URL)) pullRequests.add(match[0]);
        if (/^To https:\/\/github\.com\//m.test(output)) pushes.push(output.slice(0, 400));
      }
    }
    if (event.type === 'assistant' && event.message && !event.parent_tool_use_id) {
      const text = textOf(content);
      if (text) answered.push({ at: event.created_at, text });
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_use' && /AskUserQuestion|SendUserMessage/.test(block.name)) questions.push(JSON.stringify(block.input).slice(0, 2000));
      }
    }
  }
  for (const message of answered) for (const match of message.text.matchAll(PR_URL)) pullRequests.add(match[0]);
  const lastAsked = asked.length ? asked[asked.length - 1].at : '';
  const sinceLastAsked = answered.filter(message => message.at >= lastAsked);
  return {
    first_task: asked[0]?.text.slice(0, 4000) ?? '',
    first_task_is_summary: true,
    first_task_truncated: (asked[0]?.text.length ?? 0) > 4000,
    first_task_limit_utf16_units: 4000,
    first_task_total_utf16_units: asked[0]?.text.length ?? 0,
    later_user_messages: asked.slice(1).slice(-3).map(message => ({ at: message.at, text: message.text.slice(0, 1500) })),
    final_messages: (sinceLastAsked.length ? sinceLastAsked : answered).slice(-4).map(message => ({ at: message.at, text: message.text.slice(-6000) })),
    pull_requests: [...pullRequests],
    pushes: pushes.slice(-5),
    questions,
    event_count: events.length,
  };
}

export async function dispatchCloudSessions([command, folderName, ...rest], { authenticate = signIn, request = fetch, print = console.log, resolveBrief = briefFrom } = {}) {
  if (command === 'accounts') {
    if (folderName !== undefined || rest.length) throw new Error('usage: accounts');
    const home = homedir();
    const folders = readdirSync(home, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^\\.claude(?:[-_][A-Za-z0-9_-]+)?$/.test(item.name)
        && existsSync(join(home, item.name, '.claude.json')))
      .map(item => item.name).sort();
    const answer = { folders, count: folders.length };
    print(JSON.stringify(answer));
    return answer;
  }
  if (command === 'read-first') {
    if (rest.length < 1 || rest.length > 4) throw new Error('usage: read-first <config-folder> <session-id> [offset] [length] [snapshot]');
    const [session, offset = '0', length = String(FIRST_TEXT_BYTES), snapshot] = rest;
    if (!/^\d+$/.test(offset) || !/^\d+$/.test(length)) throw new Error('offset and length must be decimal byte integers.');
    const answer = await readFirstUserText(folderName, session, { offset: Number(offset), length: Number(length), snapshot }, { authenticate, request });
    print(JSON.stringify(answer));
    return answer;
  }
  const account = await authenticate(folderName);
  if (command === 'list-json') {
    if (rest.length > 1 || !/^[0-9]+$/.test(rest[0] ?? '100')) throw new Error('usage: list-json <config-folder> [limit 1..200]');
    const limit = Number(rest[0] ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('list-json limit must be 1..200');
    const rows = (await everyPage(account, '/v1/sessions', Math.min(100, limit), { request, until: sessions => sessions.length >= limit })).slice(0, limit).map(sessionRow);
    const answer = { config_folder: folderName, sessions: rows, count: rows.length, limited: rows.length === limit };
    print(JSON.stringify(answer));
    return answer;
  }
  if (command === 'read-one') {
    if (rest.length !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(rest[0])) throw new Error('usage: read-one <config-folder> <session-id>');
    const session = await get(account, `/v1/sessions/${rest[0]}`, undefined, { request, includeErrorBody: false });
    const said = whatItSaid(await everyPage(account, `/v1/sessions/${rest[0]}/events`, 1000, { request, includeErrorBody: false }));
    const answer = { config_folder: folderName, ...sessionRow(session), ...said };
    print(JSON.stringify(answer));
    return answer;
  }
  if (command === 'list') {
    const rows = (await everyPage(account, '/v1/sessions', 100)).map(sessionRow);
    writeFileSync(rest[0], JSON.stringify(rows));
    console.log(`${folderName}: ${rows.length} sessions`);
    return;
  }
  if (command === 'read') {
    const [listPath, outFolder, atOnce = '6'] = rest;
    mkdirSync(outFolder, { recursive: true });
    const sessions = JSON.parse(readFileSync(listPath, 'utf8'));
    const queue = sessions.filter(session => !existsSync(join(outFolder, `${session.id}.json`)));
    const waiting = queue.length;
    let read = 0;
    let failed = 0;
    const worker = async () => {
      for (let session = queue.shift(); session; session = queue.shift()) {
        try {
          const said = whatItSaid(await everyPage(account, `/v1/sessions/${session.id}/events`, 1000));
          writeFileSync(join(outFolder, `${session.id}.json`), JSON.stringify({ config_folder: folderName, ...session, ...said }));
          read++;
        } catch (error) {
          failed++;
          console.error(`${session.id}: ${error.message}`);
        }
        if ((read + failed) % 100 === 0) console.log(`${folderName}: ${read} read, ${failed} failed`);
      }
    };
    await Promise.all(Array.from({ length: Number(atOnce) }, worker));
    console.log(`${folderName}: ${read} read, ${failed} failed, ${sessions.length - waiting} already read, ${sessions.length} listed`);
    return;
  }
  if (command === 'send') {
    const [id, from] = rest;
    if (!id) throw new Error('usage: send <config-folder> <session-id> [<record id> | - | <file>]');
    const text = await resolveBrief(from);
    // One uuid per call, kept across retries, so a retried post is the same message.
    const message = { uuid: randomUUID(), session_id: id, type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } };
    await get(account, `/v1/sessions/${id}/events`, { events: [message] });
    for (let waited = 0; waited < 90000; waited += 5000) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const events = await everyPage(account, `/v1/sessions/${id}/events`, 1000);
      const sent = events.findIndex(event => event.uuid === message.uuid);
      if (sent < 0) continue;
      const answer = events.slice(sent + 1).find(event => event.type === 'assistant' && textOf(event.message?.content));
      if (answer) {
        const session = await get(account, `/v1/sessions/${id}`);
        console.log(JSON.stringify({ session: id, sent: message.uuid, status: session.session_status, answered_at: answer.created_at, answer: textOf(answer.message.content).slice(0, 2000) }));
        return;
      }
    }
    console.log(JSON.stringify({ session: id, sent: message.uuid, answer: null, note: 'no answer within 90 seconds' }));
    return;
  }
  if (command === 'start') {
    // The first repository is the one the session works in and pushes to; the others are cloned beside it.
    const [repositories, title, from] = rest;
    const names = (repositories ?? '').split(',').filter(Boolean);
    if (!names.length || !title) throw new Error('usage: start <config-folder> <owner/repo[,owner/repo...]> <title> [<record id> | - | <file>]');
    const text = await resolveBrief(from);
    // A new session runs where this sign-in's latest cloud session ran.
    const latest = (await get(account, '/v1/sessions?limit=20')).data.find(session => session.environment_kind === 'anthropic_cloud');
    if (!latest) throw new Error(`${folderName}: no earlier cloud session names an environment to start in`);
    const session = await get(account, '/v1/sessions', {
      title,
      environment_id: latest.environment_id,
      events: [{ type: 'event', data: { uuid: randomUUID(), session_id: '', type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } } }],
      session_context: {
        sources: names.map(name => ({ type: 'git_repository', url: `https://github.com/${name}`, revision: 'main' })),
        outcomes: [{ type: 'git_repository', git_info: { type: 'github', repo: names[0], branches: [] } }],
        model: latest.session_context?.model ?? undefined,
      },
    });
    console.log(JSON.stringify({ session: session.id, status: session.session_status, repositories: names, url: session.session_url ?? null }));
    return;
  }
  throw new Error('usage: read-cloud-sessions.mjs accounts|list-json|read-one|list|read|read-first|send|start <config-folder> ...');
}

// A record id of the person's Trillion: a type and a name, `record:brief:release-plan`, never a path.
const RECORD_ID = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._~-]+)+$/;
const BRIEF_FIELDS = ['brief', 'text', 'body', 'message', 'says'];

/** The text a record's value holds: the value itself when it is text, else its first text field of BRIEF_FIELDS. */
export function briefText(id, value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) throw new Error(`${id}: no such record in the person's Trillion`);
  const field = BRIEF_FIELDS.find(name => typeof value[name] === 'string' && value[name].trim());
  if (!field) throw new Error(`${id}: its value holds no text in ${BRIEF_FIELDS.join(', ')}`);
  return value[field].trim();
}

/** One record's value, read with records:read through the account's door: { id, type } in, the value out. */
export async function readRecord(id, { url = localDoorAddress(), key = requireAccountKey(), request = fetch } = {}) {
  const type = id.slice(0, id.lastIndexOf(':'));
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: {
      address: '@own-records', method: 'records:read', request_key: `read-cloud-sessions:brief:${id}`, input: { id, type } } } }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`${id}: the door answered ${response.status}`);
  let message;
  try {
    message = body.startsWith('{') ? JSON.parse(body) : body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).pop();
  } catch {
    throw new Error(`${id}: the door's answer is not JSON`);
  }
  const result = message?.result;
  if (!result || result.isError) throw new Error(`${id}: the door refused records:read${result?.content?.[0]?.text ? `: ${result.content[0].text}` : ''}`);
  const read = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null');
  return read?.value ?? null;
}

/** The brief's text: from a record id, standard input (`-` or nothing), or a file that already exists. */
export async function briefFrom(from, { stdin = process.stdin, read = readRecord } = {}) {
  let text;
  if (from === undefined || from === '-') text = (await readAll(stdin)).trim();
  else if (RECORD_ID.test(from) && !existsSync(from)) text = briefText(from, await read(from));
  else text = readFileSync(from, 'utf8').trim();
  if (!text) throw new Error(`${from === undefined || from === '-' ? 'standard input' : from}: no brief text`);
  return text;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) await dispatchCloudSessions(process.argv.slice(2));
