#!/usr/bin/env node
// harness/ask-trillion-first.mjs
//
// Purpose
//   A turn-end hook for any AI harness that runs a command when the AI is about to finish a turn and reads a refusal
//   from it (Claude Code and Codex `Stop`). It refuses to let a turn end when the person wrote and the AI never called a
//   Trillion read tool in that turn, so consulting Trillion is a structure of the harness and not a sentence the AI may
//   skip. The AI is told once which tools to call and to look in Trillion before claiming something is missing.
//
// Non-negotiable invariants
//   1. Nothing here names a harness, a product or a phrase. Whether a harness is held to this, by which road, and which
//      tools count as reading are DATA on its row in src/harnesses.json (`consults_trillion`: road, read_tools,
//      claims_need_read), chosen by `--harness <id>`. A row whose road is not the enforcing road is never refused here.
//   2. The check is structural: a call to a listed Trillion tool exists in the turn (a turn is everything after the
//      person's last message). What the AI wrote is never matched against words.
//   3. One refusal per turn: when the harness says the hook already refused (`stop_hook_active`) the turn ends, so a
//      harness with no Trillion connection can never loop. The refusal then tells the AI to say Trillion is not connected.
//   4. A turn with no person message (a compaction boundary, a scheduled run's own prompt is a person message by the
//      harness's own rules) is never refused. An unreadable transcript never refuses.
//   5. A completed execution of a declared native read caller is also a consultation attempt, including a failed
//      read. Only its exact command and JSON object arguments count; quoted names and arbitrary snippets do not.
//      This grants no decision, permission or build fallback. Those still require their own actual outcomes.
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.Stop += { "hooks": [{ "type": "command",
//     "command": "node <this file> --harness claude-code" }] }
//   Codex, ~/.codex/hooks.json: hooks.Stop += { "hooks": [{ "type": "command",
//     "command": "node <this file> --harness codex", "timeoutSec": 10 }] }
//   Any other harness with a turn-end command hook: the same command with its own harness id.
//
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { transcriptOf, turnWithAskFromFile } from './decide-before-building.mjs';
import { keepHookRunOnExit } from './hook-run-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'ask-trillion-first.json'), 'utf8'));

/** The `consults_trillion` shape for one harness id: its row when the rows carry it, else the settings' own shape.
 *  Rows are read from the first of `harness_rows` that exists (a downloaded copy beside the hook, else the repository's). */
export function consultsFor(harnessId, rules = settings, base = HERE) {
  let rows = null;
  const path = rules.harness_rows.map(item => join(base, item)).find(item => existsSync(item));
  try { if (path) rows = JSON.parse(readFileSync(path, 'utf8')); } catch { rows = null; }
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.harnesses) ? rows.harnesses : rows && typeof rows === 'object' ? Object.entries(rows).map(([id, row]) => ({ id, ...row })) : [];
  const row = list.find(item => item?.id === harnessId) ?? list.find(item => item?.default === true || item?.id === 'default');
  return row?.consults_trillion ?? rules.until_the_row_carries_it;
}

const trillionToolOf = name => (typeof name === 'string' ? name.match(/^mcp__trillion__(.+)$/)?.[1] ?? null : null);

// One literal command only. This deliberately refuses shell expressions rather than trying to
// infer whether an echoed, substituted, piped or chained name ever invoked the declared caller.
const commandWords = command => {
  if (typeof command !== 'string') return null;
  const text = command.trim();
  const words = [];
  const token = /'([^']*)'|"((?:[^"\\$`]|\\["\\])*)"|([^\s'"\\;|&<>$`()#]+)/y;
  let at = 0;
  while (at < text.length) {
    token.lastIndex = at;
    const found = token.exec(text);
    if (!found) return null;
    words.push(found[1] ?? (found[2] === undefined
      ? found[3].replace(/^~(?=\/|$)/, homedir()) : found[2].replace(/\\(["\\])/g, '$1')));
    at = token.lastIndex;
    if (at === text.length) break;
    const space = /^[ \t]+/.exec(text.slice(at));
    if (!space) return null;
    at += space[0].length;
  }
  return words;
};

/** Read intent from an attested, completed native execution. The allowed callers and argument
 *  fields are DATA. A nonzero exit can be a failed attempt; it is never a completed decision. */
export function nativeReadOf(item, rules = settings) {
  if (item.kind !== 'command_completed' || !Number.isInteger(item.exit_code)
    || !Array.isArray(item.command) || !item.command.every(word => typeof word === 'string')) return null;
  let words = item.command;
  if (words.length === 3 && rules.native_shells?.includes(words[0]) && rules.native_shell_flags?.includes(words[1])) {
    words = commandWords(words[2]);
  }
  if (!words || words.length !== 4) return null;
  const [executable, script, tool, input] = words;
  const expand = path => path.replace(/^~(?=\/|$)/, homedir()).replaceAll('{node}', process.execPath);
  const caller = rules.native_callers?.find(row => row.executables.some(word => expand(word) === executable)
    && expand(row.script) === script && Object.hasOwn(row.tools, tool));
  if (!caller) return null;
  let args;
  try { args = JSON.parse(input); } catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || !Object.entries(caller.tools[tool]).every(([key, type]) => Object.hasOwn(args, key)
      && typeof args[key] === type && (type !== 'string' || args[key].trim()))) return null;
  return { tool, arguments: args, failed: item.exit_code !== 0 };
}

/** The refusal for one turn-end event: null to allow, or the reason the AI is shown. */
export function judge(event, { harnessId = null, read = null, rules = settings, consults = consultsFor(harnessId, rules) } = {}) {
  if (consults.road !== rules.enforcing_road) return null;
  if (event.stop_hook_active) return null;
  let found;
  try { found = turnWithAskFromFile(transcriptOf(event), read); } catch { return null; }
  if (!found.asked) return null;
  const reads = new Set(consults.read_tools);
  if (found.turn.some(item => item.kind === 'call' && reads.has(trillionToolOf(item.name))
    || reads.has(nativeReadOf(item, rules)?.tool))) return null;
  return rules.refusal.replace('{tools}', consults.read_tools.slice(0, 6).join(', ')).replace('{claims}', consults.claims_need_read ? rules.claims_sentence : '');
}

// Retired universal hook entry. Contextual source reads and optional decision helpers remain available.
