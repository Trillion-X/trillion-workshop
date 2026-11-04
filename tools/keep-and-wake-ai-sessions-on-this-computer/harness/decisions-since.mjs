#!/usr/bin/env node
// harness/decisions-since.mjs
//
// Purpose
//   A prompt hook for any AI coding harness (Claude Code's UserPromptSubmit, Codex's UserPromptSubmit, anything that
//   runs a command when the person sends a message and adds what it prints to that turn). It asks the person's
//   Trillion what this session has not seen yet (POST /mcp/api/notices/unseen, src/notices.mjs) and prints those
//   decisions into the turn, so every AI working for the person starts its turn knowing what was decided elsewhere,
//   without calling a tool. Trillion keeps one cursor per session, so each decision is printed once per session.
//   When the session's transcript lies under a harness that harness/record-every-message.mjs records, it starts that
//   recorder for the submitted prompt and prints recorded_line, so the AI does not call record_messages for the same
//   turn and keep it twice. The existing Stop hook retries the transcript with the same message identity.
//
// Non-negotiable invariants
//   1. Nothing here names a harness: where a prompt event carries its session id and transcript, the address, the
//      key's Keychain item, the time box and the words are DATA in decisions-since.json beside this file; which
//      harnesses are recorded is read from record-every-message.json, never listed here.
//   2. It never blocks the turn beyond time_box_ms (2 seconds), never fails it, and always exits 0. When no decision
//      is new, or anything goes wrong (no key, no network, a slow answer), it prints no decisions.
//   3. The account key is read from the macOS Keychain by name, held in memory and put only in the Authorization header.
//   4. The held thing is never printed here as a line telling the AI to put it in front of the person: Trillion itself
//      reaches the person with it on every surface (src/waiting-on-you.json `hold.devices`, tool:take-me-there), and a
//      chat gets it as one of these notices, like any surface (test/decisions-since-held-line.test.mjs).
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.UserPromptSubmit += { "matcher": "", "hooks": [{ "type": "command",
//     "command": "node <this file>", "timeout": 5 }] }
//   Codex, ~/.codex/hooks.json: hooks.UserPromptSubmit += { "matcher": "", "hooks": [{ "type": "command",
//     "command": "node <this file>", "timeoutSec": 5 }] }
//   Existing entries stay; this is one more hook in the list.
//
import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepHookRunOnExit } from './hook-run-receipt.mjs';
import { settings as recording, transcriptFor } from './record-every-message.mjs';
import { accountKeyOrNull } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'decisions-since.json'), 'utf8'));

const at = (value, path) => path.reduce((item, key) => (item == null ? undefined : item[key]), value);

/** The reader this prompt event is, or null when it names no session. */
export function readerOf(event, rules = settings) {
  const id = rules.session_id_paths.map(path => at(event, path)).find(value => typeof value === 'string' && value.trim());
  return id ? `${rules.reader_prefix}${id}` : null;
}

const expand = path => path.replace(/^~(?=\/|$)/, homedir());

/** Whether this event's transcript is one record-every-message.mjs records: it lies under one of its harnesses' roots. */
export function recordedHere(event, rules = settings, recorded = recording, env = process.env) {
  return Boolean(recordingHarnessFor(event, rules, recorded, env));
}

/** The exact transcript harness for prompt intake; unknown paths never become founder messages. */
export function recordingHarnessFor(event, rules = settings, recorded = recording, env = process.env) {
  const path = rules.transcript_paths.map(where => at(event, where)).find(value => typeof value === 'string' && value.trim())
    ?? transcriptFor(rules.session_id_paths.map(where => at(event, where)).find(value => typeof value === 'string' && value.trim()), recorded);
  if (!path) return null;
  const file = resolve(expand(path));
  return recorded.harnesses.find(harness => harness.transcript_roots.some(root => {
    const home = root.home_variable && env[root.home_variable];
    const folder = resolve(home ? join(home, root.home_subfolder ?? '') : expand(root.folder));
    return file.startsWith(folder + sep);
  }))?.id ?? null;
}

/** Whether the prompt is the person's own words: not a program's (sdk), another chat's (peer) or text a tool put in. */
export const fromThePerson = (event, recorded = recording) => typeof event?.prompt === 'string' && Boolean(event.prompt.trim())
  && event.promptSource !== 'sdk' && event.turnOrigin !== 'sdk' && event.entrypoint !== 'sdk-cli'
  && event.origin?.kind !== 'peer' && event.attachment?.origin?.kind !== 'peer'
  && !recorded.injected_text.some(row => new RegExp(row.pattern).test(event.prompt));

/** Start prompt intake without delaying the prompt hook's own two-second decision notice. */
export function startPromptIntake(event, { launch = spawn, rules = settings, recorded = recording, env = process.env } = {}) {
  const harness = recordingHarnessFor(event, rules, recorded, env);
  if (!harness || !fromThePerson(event, recorded)) return false;
  const child = launch(process.execPath, [join(HERE, 'record-every-message.mjs'), '--harness', harness], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({ ...event, hook_event_name: 'UserPromptSubmit' }));
  child.unref();
  return true;
}

/** The lines to print for these notices: nothing when there are none. */
export const linesFor = (notices, rules = settings) => (notices.length ? [rules.heading, ...notices.map(notice => `- ${notice.said}`)].join('\n') : '');

const keychainKey = async item => accountKeyOrNull({ item, timeout: 1000 });

/** What to print for one prompt event, within `signal`. `key()` gives the account key; `fetchImpl` reaches Trillion. */
export async function decisionsSince(event, options = {}) {
  return [recordedLineFor(event, options), await unseenDecisions(event, options).catch(() => '')].filter(Boolean).join('\n');
}

/** recorded_line when record-every-message.mjs records this session, else nothing. */
export const recordedLineFor = (event, { rules = settings, recorded = recording, env = process.env } = {}) => (recordedHere(event, rules, recorded, env) ? rules.recorded_line : '');

/** The unseen decisions for this session as lines, or nothing. */
export async function unseenDecisions(event, { rules = settings, key = () => keychainKey(rules.keychain_item), fetchImpl = fetch, signal } = {}) {
  const reader = readerOf(event, rules);
  if (!reader) return '';
  const secret = await key();
  if (!secret) return '';
  const answer = await fetchImpl(`${rules.origin}${rules.unseen_path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ reader }), signal });
  if (!answer.ok) return '';
  // The held thing arrives among the notices, as on any surface; it is never a line of its own (invariant 4).
  const { notices } = await answer.json();
  return Array.isArray(notices) ? linesFor(notices.filter(notice => typeof notice?.said === 'string'), rules) : '';
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const timer = setTimeout(() => process.exit(0), settings.time_box_ms);
  // Each part is written as soon as it is known, so what is known is said even when the time box ends the rest.
  const say = text => { if (text) writeSync(1, `${text}\n`); };
  try {
    const event = JSON.parse((await readStdin()) || '{}');
    keepHookRunOnExit(import.meta.url, event);
    startPromptIntake(event);
    say(recordedLineFor(event));
    say(await unseenDecisions(event, { signal: AbortSignal.timeout(settings.time_box_ms - 100) }));
  } catch { /* nothing more is printed; the turn goes on */ }
  clearTimeout(timer);
  process.exit(0);
}
