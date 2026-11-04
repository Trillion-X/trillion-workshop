#!/usr/bin/env node
// harness/keep-written-files.mjs
//
// Purpose
//   A turn-end hook for any AI coding harness (Claude Code's Stop, Codex's Stop, anything that runs a command when a
//   turn ends). It looks through the folders a person chose on this computer, finds every text file written or changed
//   since it last looked, and keeps each one in the person's Trillion (POST /mcp/api/namespace/write, the route
//   write_file uses) under the folder's destination, with a short header naming where it came from and when it last
//   changed. A plan, a research note or a knowledge note an AI writes on this computer is readable by every AI signed
//   in to the person's Trillion by the end of that turn, without any AI choosing to call a tool.
//
// Non-negotiable invariants
//   1. Nothing here names a person, a folder or a project: which folders are watched, which files in them count,
//      where each lands and which files are left out are the person's DATA (keep-written-files.json beside this file
//      names where that list lives, ~/.trillion/keep-written-files/folders.json by default).
//   2. The body under the header is the file exactly as written, except that a value matching one of the secret
//      patterns is replaced by "[removed " + its label + "]" and the header says so; a key never leaves this computer.
//   3. The state (~/.trillion/keep-written-files/sent.json) records a file only after Trillion accepted it, keyed by
//      path with the change time sent, so each turn sends only what changed; a resend of the same bytes is only named
//      again (write_file answers already_kept), never a second copy.
//   4. It never blocks or slows the turn beyond its time box, prints nothing, and always exits 0. What was not sent in
//      time is sent at the next turn end.
//   5. The account key is read from the macOS Keychain by name at send time, held in memory and put only in the
//      Authorization header.
//
// Folder list shape (folders.json): [{ "root": "~/some/folder", "destination": "/knowledge/some-folder/",
//   "include": [regular expressions over the path inside root], "exclude": [the same], "since": an ISO date (files
//   last changed before it are not sent), "leave_out_listed_in": an optional file with one path inside root per line }]
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.Stop += { "matcher": "", "hooks": [{ "type": "command",
//     "command": "node <this file>", "timeout": 10, "async": true }] }
//   Codex, ~/.codex/hooks.json: hooks.Stop += { "matcher": ".*", "hooks": [{ "type": "command",
//     "command": "node <this file>", "timeoutSec": 10 }] }; trust its hash as record-every-message.mjs describes.
//   Send everything due now, with no time box, and print how many were sent: node <this file> --all
//
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAccountKey } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'keep-written-files.json'), 'utf8'));

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const readLines = path => { try { return readFileSync(path, 'utf8').split('\n').map(line => line.trim()).filter(Boolean); } catch { return []; } };
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every file under `root` (as paths inside it) whose path one include pattern matches and no exclude pattern does. */
export function filesIn(root, { include = [], exclude = [] }, rules = settings) {
  const taken = include.map(pattern => new RegExp(pattern));
  const dropped = [...exclude, ...rules.never_folders.map(name => `(^|/)${literal(name)}(/|$)`)].map(pattern => new RegExp(pattern));
  const found = [];
  const walk = inside => {
    let entries = [];
    try { entries = readdirSync(join(root, inside), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = inside ? `${inside}/${entry.name}` : entry.name;
      if (dropped.some(pattern => pattern.test(path))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && taken.some(pattern => pattern.test(path))) found.push(path);
    }
  };
  walk('');
  return found.sort();
}

/** The text kept in Trillion for one file: a header naming its source and change time, then its body with secrets removed. */
export function keptText(sourcePath, body, changedAt, rules = settings) {
  const removed = [];
  let text = body;
  for (const { pattern, label } of rules.secret_patterns) {
    text = text.replace(new RegExp(pattern, 'g'), () => { removed.push(label); return `[removed ${label}]`; });
  }
  const quote = value => JSON.stringify(String(value));
  const head = ['---', `source_path: ${quote(sourcePath)}`, `last_changed: ${quote(changedAt)}`,
    ...(removed.length ? [`removed_secrets: ${quote([...new Set(removed)].join(', '))}`] : []),
    `kept_by: ${quote(rules.kept_by)}`, '---', ''].join('\n');
  return { text: head + text, removed };
}

/** Files due to be sent, newest first: included, changed on or after `since`, not left out, not already sent at this change time. */
export function dueFiles(folders, sent, rules = settings) {
  const due = [];
  for (const folder of folders) {
    const root = expand(folder.root);
    const since = folder.since ? Date.parse(folder.since) : 0;
    const leftOut = new Set(folder.leave_out_listed_in ? readLines(expand(folder.leave_out_listed_in)) : []);
    for (const inside of filesIn(root, folder, rules)) {
      if (leftOut.has(inside)) continue;
      const source = join(root, inside);
      let stat;
      try { stat = statSync(source); } catch { continue; }
      if (stat.mtimeMs < since || stat.size > rules.max_bytes || sent[source] === stat.mtimeMs) continue;
      due.push({ source, name: `${folder.destination.replace(/\/?$/, '/')}${inside}`, changed: stat.mtimeMs });
    }
  }
  return due.sort((a, b) => b.changed - a.changed);
}

/** Saves one file in Trillion; resolves true when it was kept. */
export async function sendToTrillion(file, { rules = settings, deadline, key } = {}) {
  const response = await fetch(`${rules.origin.replace(/\/$/, '')}${rules.write_path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(file), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  if (!response.ok && process.argv.includes('--all')) console.error(`Could not keep ${file.name}: HTTP ${response.status}`);
  return response.ok;
}

const keychainKey = name => requireAccountKey({ item: name, timeout: 2000 });

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}.part`, JSON.stringify(state));
  renameSync(`${path}.${process.pid}.part`, path);
}

/** Sends every due file it can within the time box. Returns { sent, pending, names } and never throws. */
export async function keepNew({ rules = settings, send = sendToTrillion, key = () => keychainKey(rules.keychain_item), now = Date.now } = {}) {
  const deadline = now() + rules.time_box_ms;
  const folders = readJson(expand(rules.folders_file), []);
  const statePath = expand(rules.state_file);
  const sent = readJson(statePath, {});
  const due = dueFiles(Array.isArray(folders) ? folders : [], sent, rules);
  const names = [];
  const failed = [];
  let secret = null;
  for (const file of due) {
    try {
      if (now() >= deadline) break;
      const { text } = keptText(file.source, readFileSync(file.source, 'utf8'), new Date(file.changed).toISOString(), rules);
      secret ??= key();
      if (!(await send({ name: file.name, text, media_type: rules.media_type }, { rules, deadline, key: secret }))) {
        failed.push(file.name);
        continue;
      }
      // Read the state again just before writing, so a turn ending at the same moment in another session is not undone.
      writeState(statePath, Object.assign(sent, readJson(statePath, {}), { [file.source]: file.changed }));
      names.push(file.name);
    } catch {
      failed.push(file.name);
    }
  }
  return { sent: names.length, pending: due.length - names.length, names, failed };
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const all = process.argv.includes('--all');
  if (!all) {
    // The turn must never wait on this: past the time box the process ends, whatever it was doing.
    setTimeout(() => process.exit(0), settings.time_box_ms + 500).unref();
    for await (const chunk of process.stdin) void chunk;
  }
  const rules = all ? { ...settings, time_box_ms: 60 * 60 * 1000 } : settings;
  const result = await keepNew({ rules }).catch(() => ({ sent: 0, pending: 0 }));
  if (all) console.log(JSON.stringify({ sent: result.sent, pending: result.pending, failed: result.failed }));
  process.exit(0);
}
