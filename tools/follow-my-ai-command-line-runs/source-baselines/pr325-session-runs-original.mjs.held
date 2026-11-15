// harness/session-runs.mjs
//
// Purpose
//   What the helper adds around one run of the person's own AI command line (Claude Code, Codex) that it starts on a
//   message (harness/wake-handlers/wake-named-session.mjs):
//   - the run's live events, normalised from that CLI's own stream to text / thinking / tool_start / tool_done / reply
//     by its wake-sessions.json `stream` row, and kept as one progress file that computer/report-progress.mjs shows as
//     a live card (its "ai-session-run" row);
//   - the tools the person allows that AI in one workspace folder, kept in this computer's settings file and passed as
//     the CLI's own allow-list flag (the row's `allowed_tools`). Nothing widens permissions by default: a folder with no
//     list runs with the CLI's own permission rules, and a CLI with no allow-list flag is answered as not applying.
//
// Non-negotiable invariants
//   1. Nothing here names a CLI or an event: the flags, where they go and the event map are DATA (wake-sessions.json).
//   2. A line that is not JSON or matches no row is ignored; the run itself is never changed by what is read from it.
//   3. The progress file keeps counts, the last tool's name and at most `show_text_characters` of the kinds listed in
//      `show_text`; it is written at most every `progress_every_ms`, and once more when the run ends.
//   4. The allow-list is the person's own: set, read and cleared only through these functions (wake-sessions.mjs
//      --allow-tools / --tools / --clear-tools), for a folder that exists.
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { computerSettings, keepComputerSettings } from './chosen-ai.mjs';

const at = (value, path) => (path ?? []).reduce((here, step) => (here === null || here === undefined ? undefined : here[step]), value);
const matches = (value, when) => (when ?? []).every(test => at(value, test.path) === test.is);

/** The events one stream line says, as { kind, text?, name?, id? } in the order the CLI wrote them. */
export function eventsOfLine(stream, line) {
  let value;
  try { value = JSON.parse(line); } catch { return []; }
  if (!value || typeof value !== 'object') return [];
  // Several rows can read the same list (a message's content blocks); events keep the list's own order.
  const found = stream.events.flatMap((row, rowAt) => {
    if (!matches(value, row.when)) return [];
    const items = row.each ? at(value, row.each) : [value];
    return (Array.isArray(items) ? items : []).flatMap((item, itemAt) => {
      if (!matches(item, row.item_when)) return [];
      const text = at(item, row.text), name = at(item, row.name), id = at(item, row.id);
      return [{ itemAt, rowAt, event: { kind: row.kind, ...(typeof text === 'string' ? { text } : {}), ...(typeof name === 'string' ? { name } : {}), ...(typeof id === 'string' ? { id } : {}) } }];
    });
  });
  return found.sort((a, b) => a.itemAt - b.itemAt || a.rowAt - b.rowAt).map(item => item.event);
}

/** Turns a byte stream into whole lines: push(chunk) calls onLine for each completed line; end() flushes the rest. */
export function lineSplitter(onLine) {
  let rest = '';
  return {
    push(chunk) { rest += chunk; const lines = rest.split('\n'); rest = lines.pop(); for (const line of lines) if (line.trim()) onLine(line); },
    end() { if (rest.trim()) onLine(rest); rest = ''; },
  };
}

const folderKey = folder => { try { return realpathSync(folder); } catch { throw new Error(`The folder ${folder} does not exist.`); } };
const toolNames = tools => {
  const names = (Array.isArray(tools) ? tools : String(tools ?? '').split(',')).map(name => String(name).trim()).filter(Boolean);
  if (!names.length || names.some(name => name.length > 200 || /[\n\r]/.test(name))) throw new Error('Name the allowed tools separated by commas, for example Read,Edit,Bash(git status).');
  return [...new Set(names)];
};

/** The tools the person allows in every workspace (folder -> names), or the list for one folder. */
export const workspaceTools = (rules, folder) => {
  const kept = computerSettings(rules).workspace_tools ?? {};
  if (folder === undefined) return kept;
  try { return kept[folderKey(folder)] ?? null; } catch { return null; }
};
export function setWorkspaceTools(rules, folder, tools) {
  const key = folderKey(folder);
  keepComputerSettings({ workspace_tools: { ...(computerSettings(rules).workspace_tools ?? {}), [key]: toolNames(tools) } }, rules);
  return { folder: key, tools: workspaceTools(rules, key) };
}
export function clearWorkspaceTools(rules, folder) {
  const key = folderKey(folder);
  const { [key]: removed, ...rest } = computerSettings(rules).workspace_tools ?? {};
  keepComputerSettings({ workspace_tools: rest }, rules);
  return { folder: key, cleared: Boolean(removed) };
}

/** The command for one run: the row's resume argv plus its stream flags and the folder's allow-list, each inserted
 *  right after the argv part the DATA names. Answers { argv, streamed, tools_applied }. */
export function runArgv(harness, argv, { tools = null } = {}) {
  const insert = (list, after, parts) => { const index = list.indexOf(after); return index === -1 ? list : [...list.slice(0, index + 1), ...parts, ...list.slice(index + 1)]; };
  let next = argv;
  const streamed = Boolean(harness.stream) && argv.includes(harness.stream.after);
  if (streamed) next = insert(next, harness.stream.after, harness.stream.flags);
  const allow = harness.allowed_tools;
  const tools_applied = Boolean(tools?.length && allow && next.includes(allow.after));
  if (tools_applied) next = insert(next, allow.after, [allow.flag, tools.join(allow.join)]);
  return { argv: next, streamed, tools_applied };
}

/** Keeps one run's progress file from its events: event(e) counts it, end(state) writes the final state. */
export function progressKeeper({ path, app, stream, now = () => Date.now(), write = writeProgress }) {
  const state = { app, state: 'running', events: 0, tools_started: 0, tools_done: 0, last_kind: null, last_text: null, tool: null, reply: null, pid: process.pid };
  let wroteAt = -Infinity;
  const show = (kind, text) => (stream.show_text.includes(kind) && typeof text === 'string' ? text.trim().slice(-stream.show_text_characters) : null);
  const save = () => { wroteAt = now(); write(path, { ...state, updated_at: new Date(wroteAt).toISOString() }); };
  save();
  return {
    event(item) {
      state.events += 1;
      state.last_kind = item.kind;
      if (item.kind === 'tool_start') { state.tools_started += 1; state.tool = item.name ? item.name.slice(0, stream.show_text_characters) : state.tool; }
      if (item.kind === 'tool_done') state.tools_done += 1;
      if (item.kind === 'reply') state.reply = item.text ?? state.reply;
      const text = show(item.kind, item.text);
      if (text) state.last_text = text;
      if (now() - wroteAt >= stream.progress_every_ms) save();
    },
    end(final) { state.state = final; save(); return state; },
    get reply() { return state.reply; },
  };
}

export function writeProgress(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(part, path);
}

/** Where one session's progress file is: under the helper's folder (wake-sessions.json `folder`/`progress_folder`). */
export const progressPath = (rules, agentId) => join(rules.folder.replace(/^~(?=\/|$)/, homedir()), rules.progress_folder, agentId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 120), 'progress.json');
