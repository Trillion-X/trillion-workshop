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
//     node harness/read-cloud-sessions.mjs send <config-folder> <session-id> <message-file>
//     node harness/read-cloud-sessions.mjs start <config-folder> <owner/repo[,owner/repo...]> <title> <message-file>
//
//   <config-folder> is a CLAUDE_CONFIG_DIR folder name under the home folder (for example .claude-account1).
//   `read` writes <out-folder>/<session-id>.json per session and skips sessions already written, so a cut-off run
//   is simply run again. `send` posts the text of <message-file> to the session as the person's next message (the
//   claude.ai/code page's own road, POST /v1/sessions/<id>/events), which starts the session's next turn, and prints
//   the session's status and its first answer after it. `start` makes a new session with every repository named
//   cloned from its main (the first is the one it works in), with the text of <message-file> as its first message, in
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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.anthropic.com';
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

function signIn(folderName) {
  const folder = join(homedir(), folderName);
  const org = JSON.parse(readFileSync(join(folder, '.claude.json'), 'utf8')).oauthAccount.organizationUuid;
  const item = `Claude Code-credentials-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
  const oauth = JSON.parse(execFileSync('security', ['find-generic-password', '-s', item, '-w'], { encoding: 'utf8' })).claudeAiOauth;
  if (oauth.expiresAt < Date.now()) throw new Error(`${folderName}: sign-in expired at ${new Date(oauth.expiresAt).toString()}`);
  return { org, token: oauth.accessToken };
}

async function get(account, path, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(API + path, {
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
    throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

async function everyPage(account, path, limit) {
  const all = [];
  let after = null;
  for (;;) {
    const page = await get(account, `${path}?limit=${limit}${after ? `&after_id=${after}` : ''}`);
    all.push(...page.data);
    if (!page.has_more || !page.data.length || page.last_id === after) return all;
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
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n');
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
    later_user_messages: asked.slice(1).slice(-3).map(message => ({ at: message.at, text: message.text.slice(0, 1500) })),
    final_messages: (sinceLastAsked.length ? sinceLastAsked : answered).slice(-4).map(message => ({ at: message.at, text: message.text.slice(-6000) })),
    pull_requests: [...pullRequests],
    pushes: pushes.slice(-5),
    questions,
    event_count: events.length,
  };
}

async function main([command, folderName, ...rest]) {
  const account = signIn(folderName);
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
    const [id, messageFile] = rest;
    const text = readFileSync(messageFile, 'utf8').trim();
    if (!text) throw new Error(`${messageFile}: no message text`);
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
    const [repositories, title, messageFile] = rest;
    const text = readFileSync(messageFile, 'utf8').trim();
    const names = repositories.split(',').filter(Boolean);
    if (!text || !names.length || !title) throw new Error('usage: start <config-folder> <owner/repo[,owner/repo...]> <title> <message-file>');
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
  throw new Error('usage: read-cloud-sessions.mjs list|read|send|start <config-folder> ...');
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) await main(process.argv.slice(2));
